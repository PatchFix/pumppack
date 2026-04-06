import WebSocket from 'ws';
import axios from 'axios';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import puppeteer from 'puppeteer';
import fs from 'fs';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WS_URL = 'wss://pumpportal.fun/api/data';
let ws = null;
let lastMessageTime = Date.now();
let heartbeatInterval = null;
let reconnectTimeout = null;

// In-memory token storage
const tokens = new Map();

// Minimal token cache for metadata updates (always maintained, even when STORE_TOKENS is false)
// This ensures metadata updates can work even if client missed creation event
const tokenCache = new Map();

// Map to store migration timeouts (mint -> timeoutId)
const migrationTimeouts = new Map();

// Map to store last transaction time for each token (mint -> timestamp)
const lastTransactionTime = new Map();

// Alert storage
const alerts = new Map();
let alertIdCounter = 1;

// Track which user alerts have been triggered (to avoid duplicate notifications)
// Format: username-mint-alertId
const triggeredUserAlerts = new Set();

// Track processed token events (CTO, Boost, Ads)
const processedCTOs = new Set(); // Track processed CTO event IDs (tokenAddress)
const processedBoosts = new Set(); // Track processed Boost event IDs (tokenAddress)
const processedAds = new Set(); // Track processed Ads event IDs (tokenAddress)
const processedOGs = new Map(); // Track OG events (twitter -> [{mint: string, created: number}, ...])
const triggeredOGTwitter = new Set(); // Track Twitter addresses that have already triggered an OG event
let currentTopStreamMint = null; // Track the current top stream token mint
let currentTopStreamParticipants = 0; // Track the current top stream participant count
let currentTopStreamThumbnail = null; // Track the current top stream thumbnail

// Configuration: Store tokens in memory and subscribe to trades
// If false, only broadcast to connected clients without storing
const STORE_TOKENS = true;

// Maximum number of tokens to keep in memory
const MAX_TOKENS = 100;

// Solana price in USD (updated every minute)
let solanaPriceUSD = 0;

// Current metas data (trending words)
let currentMetas = [];

// Launch token tracking
// This will be set to the mint address when the specified developer creates a token
let launchToken = null;
const LAUNCH_DEVELOPER_WALLET = 'AvHaC68btjF1d4mSDggW3ChbY4dkF3wrE9XKe5N2kzmx';

// Telegram Bot Configuration
const TELEGRAM_BOT_NAME = 'PFKit_bot';
const TELEGRAM_BOT_API_KEY = process.env.TELEGRAM_BOT_API_KEY || '8586873785:AAF55unRbhX99xCOfooTFs0Z6Pycu-FOY-A';
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_API_KEY}`;

// Express and Socket.io setup
const app = express();
const server = createServer(app);
const socketCorsEnv = process.env.SOCKET_IO_CORS_ORIGIN;
const socketCorsOrigin =
    socketCorsEnv === undefined || socketCorsEnv === ''
        ? true
        : socketCorsEnv.split(',').map((s) => s.trim());
const io = new Server(server, {
    cors: { origin: socketCorsOrigin, methods: ['GET', 'POST'] },
});


// Force HTTPS redirect middleware
app.use((req, res, next) => {
    // Check if request is secure (either directly or via proxy)
    const isSecure = req.secure || 
                     req.headers['x-forwarded-proto'] === 'https' ||
                     req.headers['x-forwarded-ssl'] === 'on';
    
    // Only redirect in production (not localhost)
    const isLocalhost = req.hostname === 'localhost' || 
                        req.hostname === '127.0.0.1' ||
                        req.hostname === '::1';
    
    if (!isSecure && !isLocalhost) {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    
    next();
});

// API routes must be defined BEFORE static files to ensure they're matched first
// Parse JSON bodies
app.use(express.json());

// API endpoint to get localToken
app.get('/api/localToken', (req, res) => {
    // If launchToken is set, return it instead of localToken
    if (launchToken !== null) {
        res.json({ localToken: launchToken });
    } else {
        const localToken = process.env.localToken || 'no data';
        res.json({ localToken });
    }
});

// Database configuration - auto-detect Postgres or use JSON
const DATABASE_URL = process.env.DATABASE_URL;
const USE_POSTGRES = !!DATABASE_URL;
let dbPool = null;

// Initialize database connection if Postgres is available
async function initDatabase() {
    if (USE_POSTGRES) {
        try {
            dbPool = new Pool({
                connectionString: DATABASE_URL,
                ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
            });
            
            // Test connection
            await dbPool.query('SELECT NOW()');
            console.log('✅ Connected to Postgres database');
            
            // Create users table if it doesn't exist
            await dbPool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    username_lower VARCHAR(16) PRIMARY KEY,
                    user_data JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);
            console.log('✅ Users table ready');
        } catch (error) {
            console.error('❌ Error initializing Postgres database:', error.message);
            console.log('⚠️  Falling back to JSON file storage');
            dbPool = null;
        }
    } else {
        console.log('ℹ️  Using JSON file storage (local development)');
    }
}

// Initialize database on startup
// Note: We don't wait for this to complete before starting the server
// The readClients/writeClients functions will fall back to JSON if Postgres isn't ready
initDatabase().catch(error => {
    console.error('Error during database initialization:', error);
    dbPool = null; // Ensure dbPool is null on error
});

// Helper function to read clients (Postgres or JSON)
async function readClients() {
    if (USE_POSTGRES && dbPool) {
        try {
            const result = await dbPool.query('SELECT username_lower, user_data FROM users');
            const clients = {};
            result.rows.forEach(row => {
                // user_data is stored as JSONB, pg automatically parses it
                // But we need to ensure it's an object, not a string
                clients[row.username_lower] = typeof row.user_data === 'string' 
                    ? JSON.parse(row.user_data) 
                    : row.user_data;
            });
            return clients;
        } catch (error) {
            console.error('Error reading from Postgres:', error.message);
            return {};
        }
    } else {
        // Fall back to JSON file
    const clientsPath = join(__dirname, 'clients.json');
    try {
        if (fs.existsSync(clientsPath)) {
            const data = fs.readFileSync(clientsPath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error reading clients.json:', error.message);
    }
    return {};
}
}

// Helper function to write clients (Postgres or JSON)
async function writeClients(clients) {
    if (USE_POSTGRES && dbPool) {
        try {
            const client = await dbPool.connect();
            try {
                await client.query('BEGIN');
                
                // Upsert each user
                for (const [usernameLower, userData] of Object.entries(clients)) {
                    await client.query(
                        `INSERT INTO users (username_lower, user_data, updated_at) 
                         VALUES ($1, $2, NOW()) 
                         ON CONFLICT (username_lower) 
                         DO UPDATE SET user_data = $2, updated_at = NOW()`,
                        [usernameLower, JSON.stringify(userData)]
                    );
                }
                
                await client.query('COMMIT');
                return true;
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error writing to Postgres:', error.message);
            return false;
        }
    } else {
        // Fall back to JSON file
    const clientsPath = join(__dirname, 'clients.json');
    try {
        fs.writeFileSync(clientsPath, JSON.stringify(clients, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error writing clients.json:', error.message);
        return false;
        }
    }
}

// Helper function to hash password
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// API endpoint to check username availability
app.post('/api/users/check-username', async (req, res) => {
    const { username } = req.body;
    
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'Username is required' });
    }
    
    // Validate username: up to 16 characters, alphanumeric only
    if (username.length > 16 || !/^[a-zA-Z0-9]+$/.test(username)) {
        return res.status(400).json({ 
            error: 'Username must be up to 16 characters and contain only letters and numbers' 
        });
    }
    
    try {
        const clients = await readClients();
    const isAvailable = !clients[username.toLowerCase()];
    res.json({ available: isAvailable });
    } catch (error) {
        console.error('Error checking username:', error);
        res.status(500).json({ error: 'Error checking username availability' });
    }
});

// API endpoint to create user profile
app.post('/api/users/create', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'Username is required' });
    }
    
    if (!password || typeof password !== 'string' || password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    
    // Validate username: up to 16 characters, alphanumeric only
    if (username.length > 16 || !/^[a-zA-Z0-9]+$/.test(username)) {
        return res.status(400).json({ 
            error: 'Username must be up to 16 characters and contain only letters and numbers' 
        });
    }
    
    try {
        const clients = await readClients();
    const usernameLower = username.toLowerCase();
    
    if (clients[usernameLower]) {
        return res.status(409).json({ error: 'Username already taken' });
    }
    
    // Create new user profile
    clients[usernameLower] = {
        username: username,
        passwordHash: hashPassword(password),
        alerts: [],
        telegramLinked: false,
        telegramChatId: null,
        createdAt: Date.now()
    };
    
        const success = await writeClients(clients);
        if (success) {
        res.json({ success: true, message: 'Profile created successfully' });
    } else {
        res.status(500).json({ error: 'Failed to create profile' });
        }
    } catch (error) {
        console.error('Error creating user profile:', error);
        res.status(500).json({ error: 'Error creating profile' });
    }
});

// API endpoint to authenticate user
app.post('/api/users/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    try {
        const clients = await readClients();
    const usernameLower = username.toLowerCase();
    const user = clients[usernameLower];
    
    if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const passwordHash = hashPassword(password);
    if (user.passwordHash !== passwordHash) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    res.json({ 
        success: true, 
        username: user.username,
        telegramLinked: user.telegramLinked || false
    });
    } catch (error) {
        console.error('Error logging in user:', error);
        res.status(500).json({ error: 'Error authenticating user' });
    }
});

// API endpoint to save alerts to user profile
app.post('/api/users/save-alerts', async (req, res) => {
    const { username, password, alerts } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (!Array.isArray(alerts)) {
        return res.status(400).json({ error: 'Alerts must be an array' });
    }
    
    try {
        const clients = await readClients();
    const usernameLower = username.toLowerCase();
    const user = clients[usernameLower];
    
    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    
    const passwordHash = hashPassword(password);
    if (user.passwordHash !== passwordHash) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    
    // Save alerts to user profile
    user.alerts = alerts;
    user.updatedAt = Date.now();
    
        const success = await writeClients(clients);
        if (success) {
        res.json({ success: true, message: 'Alerts saved successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save alerts' });
        }
    } catch (error) {
        console.error('Error saving alerts:', error);
        res.status(500).json({ error: 'Error saving alerts' });
    }
});

// API endpoint to get user alerts
app.post('/api/users/get-alerts', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    try {
        const clients = await readClients();
    const usernameLower = username.toLowerCase();
    const user = clients[usernameLower];
    
    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    
    const passwordHash = hashPassword(password);
    if (user.passwordHash !== passwordHash) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    
    res.json({ 
        success: true, 
        alerts: user.alerts || [],
        telegramLinked: user.telegramLinked || false
    });
    } catch (error) {
        console.error('Error getting alerts:', error);
        res.status(500).json({ error: 'Error getting alerts' });
    }
});

// API endpoint to receive Telegram webhook
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        const message = req.body.message;
        
        if (!message || !message.text) {
            return res.json({ ok: true });
        }
        
        const text = message.text.trim();
        const chatId = message.chat.id;
        const username = message.from.username || null;
        
        // Handle /start command with username parameter
        // Format: /start username_here
        if (text.startsWith('/start')) {
            const parts = text.split(' ');
            const linkedUsername = parts.length > 1 ? parts[1].toLowerCase() : null;
            
            if (linkedUsername) {
                try {
                    const clients = await readClients();
                    const user = clients[linkedUsername];
                    
                    if (user) {
                        // Link Telegram to user profile
                        user.telegramLinked = true;
                        user.telegramChatId = chatId;
                        user.updatedAt = Date.now();
                        
                        const success = await writeClients(clients);
                        if (success) {
                            // Send confirmation message to user
                            axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                                chat_id: chatId,
                                text: `✅ Successfully linked to profile "${user.username}"!\n\nYou will now receive alerts via Telegram when your saved alerts match new tokens.`
                            }).catch(err => {
                                console.error('Error sending Telegram message:', err.message);
                            });
                            
                            console.log(`[Telegram] Linked chat ${chatId} to user ${linkedUsername}`);
                        }
                    } else {
                        // User not found
                        axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                            chat_id: chatId,
                            text: '❌ User profile not found. Please make sure you clicked the link from your profile page.'
                        }).catch(err => {
                            console.error('Error sending Telegram message:', err.message);
                        });
                    }
                } catch (error) {
                    console.error('Error processing Telegram link:', error);
                    axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                        chat_id: chatId,
                        text: '❌ Error linking account. Please try again later.'
                    }).catch(err => {
                        console.error('Error sending Telegram message:', err.message);
                    });
                }
            } else {
                // No username provided
                axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                    chat_id: chatId,
                    text: '👋 Welcome to PumpFun ToolKit!\n\nTo link your account, please use the "Link to Telegram" button in your profile settings.'
                }).catch(err => {
                    console.error('Error sending Telegram message:', err.message);
                });
            }
        }
        
        res.json({ ok: true });
    } catch (error) {
        console.error('Error processing Telegram webhook:', error);
        res.json({ ok: true }); // Always return ok to prevent Telegram retries
    }
});

// API endpoint to check Telegram link status
app.post('/api/users/check-telegram', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    try {
        const clients = await readClients();
        const usernameLower = username.toLowerCase();
        const user = clients[usernameLower];
        
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        const passwordHash = hashPassword(password);
        if (user.passwordHash !== passwordHash) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        
        res.json({ 
            success: true, 
            telegramLinked: user.telegramLinked || false,
            telegramChatId: user.telegramChatId || null
        });
    } catch (error) {
        console.error('Error checking Telegram status:', error);
        res.status(500).json({ error: 'Error checking Telegram status' });
    }
});

// API endpoint to set Telegram webhook (admin/helper endpoint)
app.post('/api/telegram/set-webhook', async (req, res) => {
    try {
        const { webhookUrl } = req.body;
        
        if (!webhookUrl) {
            return res.status(400).json({ error: 'webhookUrl is required' });
        }
        
        if (!TELEGRAM_BOT_API_KEY) {
            return res.status(500).json({ error: 'Telegram bot API key not configured' });
        }
        
        // Set webhook via Telegram API
        const response = await axios.post(`${TELEGRAM_API_URL}/setWebhook`, {
            url: webhookUrl
        });
        
        if (response.data.ok) {
            res.json({ 
                success: true, 
                message: 'Webhook set successfully',
                webhookUrl: webhookUrl,
                result: response.data.result
            });
        } else {
            res.status(400).json({ 
                error: 'Failed to set webhook',
                description: response.data.description
            });
        }
    } catch (error) {
        console.error('Error setting webhook:', error);
        res.status(500).json({ 
            error: 'Error setting webhook',
            message: error.message
        });
    }
});

// API endpoint to get current webhook info
app.get('/api/telegram/webhook-info', async (req, res) => {
    try {
        if (!TELEGRAM_BOT_API_KEY) {
            return res.status(500).json({ error: 'Telegram bot API key not configured' });
        }
        
        const response = await axios.get(`${TELEGRAM_API_URL}/getWebhookInfo`);
        
        res.json({ 
            success: true,
            webhookInfo: response.data.result
        });
    } catch (error) {
        console.error('Error getting webhook info:', error);
        res.status(500).json({ 
            error: 'Error getting webhook info',
            message: error.message
        });
    }
});

// API endpoint to proxy live streams (avoid CORS issues)
app.get('/api/live-streams', async (req, res) => {
    try {
        const response = await axios.get('https://frontend-api-v3.pump.fun/coins/currently-live', {
            headers: {
                'Accept': 'application/json',
            },
            timeout: 10000
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching live streams:', error.message);
        res.status(500).json({ error: 'Failed to fetch live streams' });
    }
});

// API endpoint to fetch token data for event updates
app.get('/api/token/:mint', async (req, res) => {
    try {
        const { mint } = req.params;
        const tokenData = await getToken(mint);
        if (!tokenData) {
            res.status(404).json({ error: 'Token not found' });
            return;
        }
        
        // Calculate marketcap in SOL and USD
        const marketCapSol = tokenData.market_cap || tokenData.usd_market_cap_sol || 0;
        const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
        const athMarketCap = tokenData.ath_market_cap || 0;
        
        res.json({
            mint: mint,
            marketCapUSD: marketCapUSD,
            marketCapSol: marketCapSol,
            athMarketCap: athMarketCap
        });
    } catch (error) {
        console.error(`Error fetching token data for ${mint}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch token data' });
    }
});

// Full Pump.fun coin record (for watch clients; avoids browser CORS on frontend-api-v3)
app.get('/api/pump-coin/:mint', async (req, res) => {
    try {
        const { mint } = req.params;
        const tokenData = await getToken(mint);
        if (!tokenData) {
            res.status(404).json({ error: 'Token not found' });
            return;
        }
        res.json(tokenData);
    } catch (error) {
        console.error(`Error fetching pump coin ${req.params.mint}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch token' });
    }
});

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Proxy route for images to avoid CORS issues
app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
        return res.status(400).send('Missing image URL');
    }

    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Set CORS headers
        res.set({
            'Content-Type': response.headers['content-type'] || 'image/png',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000' // Cache for 1 year
        });

        res.send(Buffer.from(response.data));
    } catch (error) {
        console.error(`Error proxying image ${imageUrl}:`, error.message);
        res.status(500).send('Error loading image');
    }
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Send Solana price to newly connected client
    socket.emit('solana:price', { price: solanaPriceUSD });
    
    // Send current metas to newly connected client
    if (currentMetas && currentMetas.length > 0) {
        socket.emit('metas:current', { metas: currentMetas });
    }
    
    // Send current top live stream to newly connected client
    if (currentTopStreamMint && currentTopStreamParticipants > 0) {
        // Get fresh token data for the current top stream
        getToken(currentTopStreamMint).then(tokenData => {
            if (tokenData) {
                const marketCapSol = tokenData.usd_market_cap_sol || 0;
                const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
                const athMarketCap = tokenData.ath_market_cap || 0;
                
                const streamData = {
                    mint: currentTopStreamMint,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || null,
                    thumbnail: currentTopStreamThumbnail || null,
                    participants: currentTopStreamParticipants,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                };
                
                socket.emit('top-live-stream:update', streamData);
                console.log('[Socket] Sent current top stream to new client:', socket.id);
            }
        }).catch(error => {
            console.error('[Socket] Error fetching top stream for new client:', error.message);
        });
    }
    
    // Send all current tokens to the newly connected client (only if storing)
    if (STORE_TOKENS) {
        const allTokens = Array.from(tokens.values()).map(token => {
            return prepareTokenForBroadcast(token);
        });
        socket.emit('tokens:all', allTokens);
    } else {
        // No stored tokens to send, start fresh
        socket.emit('tokens:all', []);
    }
    
    // Handle metadata refresh request from client
    socket.on('token:refresh-metadata', async (mint) => {
        // Get token from storage or cache
        let token = STORE_TOKENS ? tokens.get(mint) : tokenCache.get(mint);
        
        // If token doesn't exist, try to fetch from API
        if (!token) {
            try {
                const apiTokenData = await getToken(mint);
                if (apiTokenData) {
                    token = {
                        mint: mint,
                        value: apiTokenData.usd_market_cap_sol || 0,
                        name: apiTokenData.name || 'Unknown',
                        symbol: apiTokenData.symbol || 'UNKNOWN',
                        deployer: apiTokenData.creator || null,
                        devBuy: null,
                        uri: apiTokenData.metadata_uri || null,
                        created: Date.now(),
                        description: null,
                        image: null,
                        twitter: null,
                        website: null,
                        telegram: null,
                        marketCapSol: apiTokenData.usd_market_cap_sol || 0,
                        allTimeHigh: apiTokenData.usd_market_cap_sol || 0, // Initialize ATH
                        totalBuys: 0,
                        totalSells: 0,
                        buyVolume: 0,
                        sellVolume: 0,
                        uniqueBuyers: new Set(),
                        tradesPerMinute: []
                    };
                    tokenCache.set(mint, token);
                } else {
                    return; // Can't create token, skip refresh
                }
            } catch (error) {
                return; // Failed to fetch token, skip refresh
            }
        }
        
        try {
            // Re-fetch token data using getToken method to get updated metadata
            const tokenData = await getToken(mint);
            if (tokenData) {
                // Update token with new data (same logic as updateTokenFromTokenData)
                let hasChanges = false;
                let twitterUpdated = false;
                let websiteUpdated = false;
                
                if (tokenData.image_uri && token.image !== tokenData.image_uri) {
                    token.image = tokenData.image_uri;
                    hasChanges = true;
                }
                if (tokenData.description !== undefined && token.description !== tokenData.description) {
                    token.description = tokenData.description;
                    hasChanges = true;
                }
                if (tokenData.twitter !== undefined && token.twitter !== tokenData.twitter) {
                    token.twitter = tokenData.twitter;
                    hasChanges = true;
                    twitterUpdated = true;
                }
                if (tokenData.website !== undefined && token.website !== tokenData.website) {
                    token.website = tokenData.website;
                    hasChanges = true;
                    websiteUpdated = true;
                }
                if (tokenData.telegram !== undefined && token.telegram !== tokenData.telegram) {
                    token.telegram = tokenData.telegram;
                    hasChanges = true;
                }
                if (tokenData.banner_uri !== undefined && token.banner_uri !== tokenData.banner_uri) {
                    token.banner_uri = tokenData.banner_uri;
                    hasChanges = true;
                }
                
                if (hasChanges) {
                    // Update both storage and cache
                    if (STORE_TOKENS) {
                        tokens.set(mint, token);
                    } else {
                        tokenCache.set(mint, token);
                    }
                    
                    // Check if token status changed and log it (only if storing)
                    if (STORE_TOKENS) {
                        const hasAllData = token.description !== null && token.image !== null;
                        const newStatus = hasAllData ? 'COMPLETE' : 'PARTIAL';
                        if (token._status !== newStatus) {
                            token._status = newStatus;
                            console.log(`Token [${newStatus}]: ${token.name} (${token.symbol}) - ${mint}`);
                        }
                    }
                    
                    // Always broadcast update to client
                    const updatedToken = prepareTokenForBroadcast(token);
                    socket.emit('token:update', updatedToken);
                    
                    // Re-check user alerts when metadata is updated (twitter/website)
                    // This ensures alerts that depend on metadata will trigger when it becomes available
                    if (twitterUpdated || websiteUpdated) {
                        checkUserAlertsForToken(token).catch(error => {
                            console.error(`Error checking user alerts after metadata refresh for token ${mint}:`, error.message);
                        });
                    }
                }
            }
        } catch (error) {
            // Silently handle errors
        }
    });
    
    // Alert management handlers
    socket.on('alerts:get', () => {
        const alertsList = Array.from(alerts.values());
        socket.emit('alerts:list', alertsList);
    });

    socket.on('alerts:create', (alertData) => {
        const alert = {
            id: `alert_${alertIdCounter++}`,
            ...alertData,
            enabled: true,
            createdAt: Date.now()
        };
        alerts.set(alert.id, alert);
        // Broadcast updated list to all clients
        const alertsList = Array.from(alerts.values());
        io.emit('alerts:list', alertsList);
        console.log(`Alert created: ${alert.id} - ${alert.type}`);
    });

    socket.on('alerts:delete', ({ id }) => {
        if (alerts.has(id)) {
            alerts.delete(id);
            const alertsList = Array.from(alerts.values());
            io.emit('alerts:list', alertsList);
            console.log(`Alert deleted: ${id}`);
        }
    });

    socket.on('alerts:toggle', ({ id }) => {
        const alert = alerts.get(id);
        if (alert) {
            alert.enabled = !alert.enabled;
            alerts.set(id, alert);
            const alertsList = Array.from(alerts.values());
            io.emit('alerts:list', alertsList);
            console.log(`Alert ${alert.enabled ? 'enabled' : 'disabled'}: ${id}`);
        }
    });
    
    // Handle dex token fetch request
    socket.on('dex:fetch-token', async ({ slot, mint }) => {
        try {
            const tokenData = await getToken(mint);
            if (!tokenData) {
                socket.emit('dex:token:error', {
                    slot: slot,
                    error: 'Token not found'
                });
                return;
            }

            // Format token data for client
            const formattedToken = {
                mint: mint,
                name: tokenData.name || 'Unknown',
                symbol: tokenData.symbol || 'UNKNOWN',
                marketCapUSD: tokenData.usd_market_cap || (tokenData.market_cap_sol && solanaPriceUSD ? tokenData.market_cap_sol * solanaPriceUSD : null),
                twitter: tokenData.twitter || null,
                website: tokenData.website || null,
                telegram: tokenData.telegram || null,
                image: tokenData.image_uri || null
            };

            socket.emit('dex:token', {
                slot: slot,
                token: formattedToken
            });
        } catch (error) {
            console.error(`Error fetching dex token ${mint}:`, error.message);
            socket.emit('dex:token:error', {
                slot: slot,
                error: error.message || 'Failed to fetch token data'
            });
        }
    });

    // Handle bulk dex token updates for marketcap refresh
    socket.on('dex:update-tokens', async ({ tokens }) => {
        console.log(`[Server] Received dex:update-tokens request for ${tokens?.length || 0} tokens`);
        if (!Array.isArray(tokens) || tokens.length === 0) {
            console.log('[Server] Invalid or empty tokens array');
            return;
        }

        try {
            // Extract all mints
            const mints = tokens.map(t => t.mint).filter(Boolean);
            if (mints.length === 0) {
                console.log('[Server] No valid mints to update');
                return;
            }

            // Create a map of mint to slot for quick lookup
            const mintToSlot = new Map();
            tokens.forEach(({ slot, mint }) => {
                if (mint) {
                    mintToSlot.set(mint, slot);
                }
            });

            console.log(`[Server] Bulk fetching updates for ${mints.length} tokens`);
            
            // Use bulk endpoint to fetch all tokens at once
            const response = await axios.post(
                'https://frontend-api-v3.pump.fun/coins/mints',
                { mints: mints },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.data || !Array.isArray(response.data)) {
                console.log('[Server] Invalid response format from bulk endpoint');
                return;
            }

            console.log(`[Server] Received ${response.data.length} tokens from bulk endpoint`);
            
            // Process each token in the response
            response.data.forEach(tokenData => {
                if (!tokenData || !tokenData.mint) {
                    return;
                }

                const slot = mintToSlot.get(tokenData.mint);
                if (slot === undefined) {
                    return; // Slot not found, skip
                }

                // Format token data for client (only updatable fields)
                const marketCapUSD = tokenData.usd_market_cap || (tokenData.market_cap_sol && solanaPriceUSD ? tokenData.market_cap_sol * solanaPriceUSD : null);
                const formattedToken = {
                    marketCapUSD: marketCapUSD
                };

                console.log(`[Server] Token ${tokenData.mint} (slot ${slot}) marketcap: $${marketCapUSD}`);
                
                // Send update to client
                socket.emit('dex:token:update', {
                    slot: slot,
                    token: formattedToken
                });
            });

            console.log(`[Server] Sent ${response.data.length} updates to client`);
        } catch (error) {
            console.error(`[Server] Error bulk updating dex tokens:`, error.message);
            // Fallback to individual calls if bulk endpoint fails
            console.log('[Server] Falling back to individual token fetches');
            
            const updatePromises = tokens.map(async ({ slot, mint }) => {
                try {
                    const tokenData = await getToken(mint);
                    if (!tokenData) {
                        return null;
                    }

                    const marketCapUSD = tokenData.usd_market_cap || (tokenData.market_cap_sol && solanaPriceUSD ? tokenData.market_cap_sol * solanaPriceUSD : null);
                    return {
                        slot: slot,
                        token: { marketCapUSD: marketCapUSD }
                    };
                } catch (error) {
                    console.error(`[Server] Error updating dex token ${mint}:`, error.message);
                    return null;
                }
            });

            const results = await Promise.all(updatePromises);
            results.forEach(result => {
                if (result) {
                    socket.emit('dex:token:update', result);
                }
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Helper function to prepare token data for broadcast
function prepareTokenForBroadcast(token) {
    const { _status, uniqueBuyers, ...tokenData } = token; // Remove internal status field and Set
    // Convert Set to Array for JSON serialization
    if (uniqueBuyers instanceof Set) {
        tokenData.uniqueBuyers = Array.from(uniqueBuyers);
    }
    return tokenData;
}

// Helper function to broadcast token updates
function broadcastTokenUpdate(token) {
    const tokenData = prepareTokenForBroadcast(token);
    io.emit('token:update', tokenData);
}

// Helper function to broadcast new token
function broadcastNewToken(token) {
    const tokenData = prepareTokenForBroadcast(token);
    io.emit('token:new', tokenData);
}

// Helper function to remove a token from storage
function removeToken(mint) {
    // Clear migration timeout if it exists
    if (migrationTimeouts.has(mint)) {
        clearTimeout(migrationTimeouts.get(mint));
        migrationTimeouts.delete(mint);
    }
    
    // Clear last transaction time
    lastTransactionTime.delete(mint);
    
    const token = tokens.get(mint);
    if (token) {
        // Unsubscribe from token trades before removing (only if storing)
        if (STORE_TOKENS) {
            const payload = {
                method: "unsubscribeTokenTrade",
                keys: [mint]
            };
            ws.send(JSON.stringify(payload));
        }
        
        tokens.delete(mint);
        // Also remove from cache
        tokenCache.delete(mint);
        // Broadcast removal to all connected clients
        io.emit('token:remove', { mint });
        return true;
    }
    // Also check cache if not in tokens
    if (tokenCache.has(mint)) {
        tokenCache.delete(mint);
        io.emit('token:remove', { mint });
        return true;
    }
    return false;
}

// Helper function to get current minute timestamp (floor to minute)
function getCurrentMinute() {
    const now = Date.now();
    return Math.floor(now / 60000) * 60000; // Round down to nearest minute
}

// Helper function to update per-minute trade data
function updateTradesPerMinute(token, isBuy, solAmount = 0) {
    const currentMinute = getCurrentMinute();
    const fifteenMinutesAgo = currentMinute - (15 * 60 * 1000);
    
    // Clean up old data (older than 15 minutes)
    token.tradesPerMinute = token.tradesPerMinute.filter(t => t.minute >= fifteenMinutesAgo);
    
    // Find or create entry for current minute
    let minuteEntry = token.tradesPerMinute.find(t => t.minute === currentMinute);
    if (!minuteEntry) {
        minuteEntry = { minute: currentMinute, buys: 0, sells: 0, buyVolume: 0, sellVolume: 0 };
        token.tradesPerMinute.push(minuteEntry);
    }
    
    // Update counts and volume
    if (isBuy) {
        minuteEntry.buys++;
        minuteEntry.buyVolume += solAmount;
    } else {
        minuteEntry.sells++;
        minuteEntry.sellVolume += solAmount;
    }
}

// Helper function to remove lowest marketcap token that is at least 2 minutes old
function removeOldestTokens() {
    if (tokens.size <= MAX_TOKENS) {
        return; // No need to remove anything
    }
    
    const now = Date.now();
    const twoMinutesAgo = now - (2 * 60 * 1000); // 2 minutes in milliseconds
    
    // Find tokens that are at least 2 minutes old
    const oldEnoughTokens = Array.from(tokens.entries())
        .map(([mint, token]) => ({
            mint,
            created: token.created || 0,
            marketCap: token.value || token.marketCapSol || 0 // Use value or marketCapSol
        }))
        .filter(token => token.created <= twoMinutesAgo);
    
    // If no tokens are old enough, temporarily allow more than 100
    if (oldEnoughTokens.length === 0) {
        console.log(`Token count (${tokens.size}) exceeds ${MAX_TOKENS}, but no tokens are old enough to remove (need 2+ minutes old)`);
        return;
    }
    
    // Sort by marketcap (lowest first) to find the lowest marketcap token
    oldEnoughTokens.sort((a, b) => a.marketCap - b.marketCap);
    
    // Remove the lowest marketcap token that is old enough
    const tokenToRemove = oldEnoughTokens[0];
    const token = tokens.get(tokenToRemove.mint);
    console.log(`Removing lowest marketcap token (${tokenToRemove.marketCap} SOL) that is at least 2 minutes old: ${tokenToRemove.mint}`);
    
    // Emit cleanup operation
    io.emit('backend:operation', {
        type: 'cleanup',
        message: `Removing old token: ${token?.name || 'Unknown'} (${tokenToRemove.marketCap.toFixed(2)} SOL)`,
        mint: tokenToRemove.mint.substring(0, 8),
        reason: 'token-limit',
        timestamp: Date.now()
    });
    
    removeToken(tokenToRemove.mint);
    
    // If still over limit, call recursively to remove more
    // The recursive call will recalculate eligible tokens from scratch
    if (tokens.size > MAX_TOKENS) {
        removeOldestTokens();
    }
}

/**
 * Fetch Solana price from CoinGecko API
 * @returns {Promise<number>} Solana price in USD
 */
async function fetchSolanaPrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'solana',
                vs_currencies: 'usd'
            },
            timeout: 5000
        });
        
        if (response.data && response.data.solana && response.data.solana.usd) {
            return response.data.solana.usd;
        }
        throw new Error('Invalid response format');
    } catch (error) {
        console.error(`Error fetching Solana price: ${error.message}`);
        // Return 0 or keep previous price if available
        return solanaPriceUSD || 0;
    }
}

/**
 * Update Solana price and broadcast to all connected clients
 */
async function updateSolanaPrice() {
    const price = await fetchSolanaPrice();
    if (price > 0) {
        solanaPriceUSD = price;
        console.log(`Solana price updated: $${price.toFixed(2)}`);
        // Broadcast updated price to all connected clients
        io.emit('solana:price', { price: solanaPriceUSD });
    }
}

// Start the server
const PORT = process.env.PORT || 3000;
/**
 * Test function to scrape community creator from a URL using headless browser
 * @param {string} url - The URL to scrape (e.g., X.com community page, pump.fun token page)
 * @returns {Promise<Object|null>} Scraped community creator data or null if failed
 */
async function comScrape(url) {
    let browser = null;
    try {
        console.log(`[comScrape] Starting scrape for: ${url}`);
        
        // Launch browser with Heroku-friendly settings
        const browserArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080'
        ];
        
        // Use Chromium from Puppeteer
        browser = await puppeteer.launch({
            headless: true,
            args: browserArgs,
            // On Heroku, the buildpack will provide the executable
        });
        
        const page = await browser.newPage();
        
        // Set user agent to avoid detection
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate to the URL
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for the page to load (X.com may need more time)
        // waitForTimeout is deprecated, use setTimeout with Promise instead
        await new Promise(resolve => setTimeout(resolve, 5000)); // Give page time to render, especially for X.com
        
        // Check if this is an X.com community page
        const isXCommunity = url.includes('x.com/i/communities/') || url.includes('twitter.com/i/communities/');
        
        // Scrape community creator data
        const communityData = await page.evaluate((isXCommunity) => {
            const result = {
                timestamp: new Date().toISOString(),
                url: window.location.href,
                creatorName: null,
                creatorLink: null,
                communityName: null,
                communityDescription: null,
                memberCount: null,
                additionalData: {}
            };
            
            if (isXCommunity) {
                // X.com/Twitter community page selectors
                // Try to find community name
                const nameSelectors = [
                    'h1[data-testid="community-name"]',
                    'h1[aria-label*="community"]',
                    'h1',
                    '[data-testid="communityHeader"] h1',
                    '[class*="community"] h1'
                ];
                
                for (const selector of nameSelectors) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent.trim()) {
                        result.communityName = element.textContent.trim();
                        break;
                    }
                }
                
                // Try to find community description
                const descSelectors = [
                    '[data-testid="community-description"]',
                    '[aria-label*="description"]',
                    'p[class*="description"]',
                    '[class*="CommunityDescription"]'
                ];
                
                for (const selector of descSelectors) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent.trim()) {
                        result.communityDescription = element.textContent.trim();
                        break;
                    }
                }
                
                // Try to find creator/admin information
                const creatorSelectors = [
                    '[data-testid="community-creator"]',
                    '[data-testid="community-admin"]',
                    '[aria-label*="creator"]',
                    '[aria-label*="admin"]',
                    '[class*="creator"]',
                    '[class*="admin"]',
                    'a[href*="/"]' // Creator link might be in a user link
                ];
                
                for (const selector of creatorSelectors) {
                    const element = document.querySelector(selector);
                    if (element) {
                        result.creatorName = element.textContent.trim() || element.getAttribute('aria-label') || null;
                        result.creatorLink = element.href || element.closest('a')?.href || null;
                        if (result.creatorName) break;
                    }
                }
                
                // Try to find member count
                const memberSelectors = [
                    '[data-testid="community-members"]',
                    '[aria-label*="member"]',
                    '[class*="member"]',
                    'span[class*="count"]'
                ];
                
                for (const selector of memberSelectors) {
                    const element = document.querySelector(selector);
                    if (element) {
                        const text = element.textContent.trim();
                        const match = text.match(/(\d+[\d,]*)\s*member/i);
                        if (match) {
                            result.memberCount = match[1];
                            break;
                        }
                    }
                }
                
                // Get page title as fallback
                if (!result.communityName) {
                    result.communityName = document.title || null;
                }
                
                // Get all text content for debugging
                result.additionalData.pageTitle = document.title;
                result.additionalData.allH1Text = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim()).filter(Boolean);
                result.additionalData.allH2Text = Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim()).filter(Boolean);
                
            } else {
                // Generic/pump.fun page selectors
                const creatorElement = document.querySelector('[data-testid="creator"]') || 
                                     document.querySelector('.creator') ||
                                     document.querySelector('[class*="creator"]') ||
                                     document.querySelector('[class*="Creator"]');
                
                result.creatorName = creatorElement?.textContent?.trim() || null;
                result.creatorLink = creatorElement?.href || creatorElement?.closest('a')?.href || null;
                
                const communityBadge = document.querySelector('[data-testid="community"]') ||
                                      document.querySelector('.community-badge') ||
                                      document.querySelector('[class*="community"]') ||
                                      document.querySelector('[class*="Community"]');
                
                result.communityName = communityBadge?.textContent?.trim() || null;
            }
            
            return result;
        }, isXCommunity);
        
        console.log(`[comScrape] Successfully scraped data:`, JSON.stringify(communityData, null, 2));
        
        await browser.close();
        return communityData;
        
    } catch (error) {
        console.error(`[comScrape] Error scraping ${url}:`, error.message);
        console.error(error.stack);
        if (browser) {
            await browser.close();
        }
        return null;
    }
}

server.listen(PORT, async () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🚀 Starting initialization...`);
    
    try {
    // Fetch Solana price at server start
        console.log(`🚀 Fetching Solana price...`);
    await updateSolanaPrice();
        console.log(`🚀 Solana price fetched`);
    
    // Update Solana price every minute
    setInterval(updateSolanaPrice, 60000); // 60000ms = 1 minute
    
    // Fetch current metas at startup
        console.log(`🚀 Fetching current metas...`);
    await updateCurrentMetas();
        console.log(`🚀 Current metas fetched`);
    
    // Update metas every 5 minutes
    setInterval(updateCurrentMetas, 300000); // 300000ms = 5 minutes
        
        // Start token events polling (CTO, Boost, Ads, Live Streams)
        console.log(`🚀 About to call startTokenEventsPolling()...`);
        startTokenEventsPolling().catch(error => {
            console.error('❌ Error starting token events polling:', error);
            console.error('❌ Error stack:', error.stack);
        });
        console.log(`🚀 startTokenEventsPolling() called`);
    } catch (error) {
        console.error('❌ Error during server initialization:', error);
        console.error('❌ Error stack:', error.stack);
    }
});

/**
 * Fetch current metas from pump.fun API
 * @returns {Promise<Object|null>} Current metas data or null if failed
 */
async function getCurrentMetas() {
    try {
        const response = await axios.get('https://frontend-api-v3.pump.fun/metas/current', {
            headers: {
                'Accept': 'application/json',
            },
            timeout: 10000
        });
        
        if (!response.data) {
            console.log('[getCurrentMetas] No data returned');
            return null;
        }
        
        return response.data;
    } catch (error) {
        console.error(`[getCurrentMetas] Error fetching current metas:`, error.message);
        return null;
    }
}

/**
 * Update current metas and broadcast to all connected clients
 */
async function updateCurrentMetas() {
    const metasData = await getCurrentMetas();
    if (metasData && Array.isArray(metasData)) {
        currentMetas = metasData;
        console.log(`[updateCurrentMetas] Updated ${metasData.length} metas`);
        // Broadcast to all connected clients
        io.emit('metas:current', { metas: currentMetas });
    }
}

/**
 * Fetch token data from pump.fun API
 * @param {string} mint - The token mint address
 * @returns {Promise<Object>} Token data from the API
 */
async function getToken(mint) {
    try {
        const response = await axios.get(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
            timeout: 10000
        });
        
        // Check if response data is empty
        if (!response.data || Object.keys(response.data).length === 0) {
            return null;
        }
        
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            // Token not found (not a pumpfun token)
            return null;
        }
        console.error(`Error fetching token data for ${mint}:`, error.message);
        return null;
    }
}

/**
 * Check if a token is a pumpfun token by fetching it from the API
 * @param {string} mint - The token mint address
 * @returns {Promise<Object|null>} Token data if it's a pumpfun token, null otherwise
 */
async function isPumpfunToken(mint) {
    try {
        const tokenData = await getToken(mint);
        return tokenData;
    } catch (error) {
        return null;
    }
}

/**
 * Fetch header image from DexScreener search API
 * @param {string} mintAddress - The token mint address
 * @returns {Promise<string|null>} Header image URL or null if not found
 */
async function getDexScreenerHeader(mintAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${mintAddress}`, {
            timeout: 10000
        });
        
        if (!response.data || !response.data.pairs || !Array.isArray(response.data.pairs) || response.data.pairs.length === 0) {
            return null;
        }
        
        // Get the first pair (usually the most relevant one)
        const firstPair = response.data.pairs[0];
        if (firstPair && firstPair.info && firstPair.info.header) {
            return firstPair.info.header;
        }
        
        return null;
    } catch (error) {
        // Silently handle errors
        return null;
    }
}

/**
 * Poll DexScreener APIs for token events (CTO, Boost, Ads)
 */
async function startTokenEventsPolling() {
    console.log('🚀 [Token Events] Starting token events polling...');
    
    try {
        // At startup, find the most recent pumpfun event from each API and report it
        console.log('🚀 [Token Events] Checking CTO events at startup...');
        await checkCTOEventsAtStartup();
        
        console.log('🚀 [Token Events] Checking Boost events at startup...');
        await checkBoostEventsAtStartup();
        
        console.log('🚀 [Token Events] Checking Ads events at startup...');
        await checkAdsEventsAtStartup();
        
        console.log('🚀 [Token Events] Checking Live Stream events at startup...');
        await checkLiveStreamEventsAtStartup();
        
        // Poll immediately; CTO/Boost/Ads every 5s, live streams every 30s
        console.log('🚀 [Token Events] Starting initial poll...');
        await checkCTOEvents();
        await checkBoostEvents();
        await checkAdsEvents();
        await checkLiveStreamEvents();
        
        console.log('🚀 [Token Events] Setting up CTO/Boost/Ads polling (5 seconds)...');
        setInterval(async () => {
            try {
                await checkCTOEvents();
                await checkBoostEvents();
                await checkAdsEvents();
            } catch (error) {
                console.error('🚀 [Token Events] Error in polling interval:', error);
            }
        }, 5000); // 5 seconds

        console.log('🚀 [Live Stream] Setting up live stream polling (30 seconds)...');
        setInterval(async () => {
            try {
                await checkLiveStreamEvents();
            } catch (error) {
                console.error('🚀 [Live Stream] Error in polling interval:', error);
            }
        }, 30000); // 30 seconds
        
        console.log('🚀 [Token Events] Polling setup complete!');
    } catch (error) {
        console.error('🚀 [Token Events] Error starting token events polling:', error);
        console.error('🚀 [Token Events] Error stack:', error.stack);
    }
}

/**
 * Check for most recent pumpfun CTO at startup
 */
async function checkCTOEventsAtStartup() {
    try {
        const response = await axios.get('https://api.dexscreener.com/community-takeovers/latest/v1', {
            timeout: 10000
        });
        
        if (!response.data || !Array.isArray(response.data)) {
            return;
        }
        
        const ctos = response.data;
        let firstPumpfunCTO = null;
        
        // First pass: Find all pumpfun tokens and mark them as processed
        // Also identify the first (most recent) one to emit
        for (const cto of ctos) {
            if (cto.chainId !== 'solana') {
                continue;
            }
            
            // Check if it's a pumpfun token
            const tokenData = await isPumpfunToken(cto.tokenAddress);
            if (tokenData) {
                // Mark ALL pumpfun tokens as processed (so regular polling won't process them)
                processedCTOs.add(cto.tokenAddress);
                
                // Store the first one we find (most recent) to emit
                if (!firstPumpfunCTO) {
                    firstPumpfunCTO = {
                        cto: cto,
                        tokenData: tokenData
                    };
                }
            }
        }
        
        // Only emit the first (most recent) pumpfun CTO
        if (firstPumpfunCTO) {
            const { cto, tokenData } = firstPumpfunCTO;
            console.log(`[CTO Startup] Found most recent pumpfun CTO: ${tokenData.name} (${tokenData.symbol}) - ${cto.tokenAddress}`);
            
            // Get marketcap from tokenData
            const marketCapSol = tokenData.usd_market_cap_sol || 0;
            const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
            const athMarketCap = tokenData.ath_market_cap || 0;
            
            // Emit the event
            io.emit('token:event', {
                type: 'cto',
                token: {
                    mint: cto.tokenAddress,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || cto.icon || null,
                    header: cto.header || null,
                    url: cto.url,
                    description: cto.description || '',
                    links: cto.links || [],
                    claimDate: cto.claimDate,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                }
            });
        }
    } catch (error) {
        console.error('Error checking CTO events at startup:', error.message);
    }
}

/**
 * Check for new CTO (Community Takeover) events
 */
async function checkCTOEvents() {
    try {
        const response = await axios.get('https://api.dexscreener.com/community-takeovers/latest/v1', {
            timeout: 10000
        });
        
        if (!response.data || !Array.isArray(response.data)) {
            return;
        }
        
        const ctos = response.data;
        
        // Process events in reverse order (newest first) but only emit new ones
        for (const cto of ctos) {
            // Skip if already processed
            if (processedCTOs.has(cto.tokenAddress)) {
                continue;
            }
            
            // Only process Solana tokens
            if (cto.chainId !== 'solana') {
                continue;
            }
            
            // Check if it's a pumpfun token
            const tokenData = await isPumpfunToken(cto.tokenAddress);
            if (!tokenData) {
                continue;
            }
            
            // Mark as processed
            processedCTOs.add(cto.tokenAddress);
            
            // Get marketcap from tokenData
            const marketCapSol = tokenData.usd_market_cap_sol || 0;
            const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
            const athMarketCap = tokenData.ath_market_cap || 0;
            
            // Emit CTO event to all connected clients
            io.emit('token:event', {
                type: 'cto',
                token: {
                    mint: cto.tokenAddress,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || cto.icon || null,
                    header: cto.header || null,
                    url: cto.url,
                    description: cto.description || '',
                    links: cto.links || [],
                    claimDate: cto.claimDate,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                }
            });
            
            console.log(`[CTO Event] ${tokenData.name} (${tokenData.symbol}) - ${cto.tokenAddress}`);
        }
    } catch (error) {
        console.error('Error checking CTO events:', error.message);
    }
}

/**
 * Check for most recent pumpfun Boost at startup
 */
async function checkBoostEventsAtStartup() {
    try {
        const response = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1', {
            timeout: 10000
        });
        
        if (!response.data) {
            return;
        }
        
        // Boost API returns an object, not an array
        let boosts = [];
        if (Array.isArray(response.data)) {
            boosts = response.data;
        } else if (response.data && typeof response.data === 'object') {
            // If it's a single object, wrap it in an array
            boosts = [response.data];
        } else {
            return;
        }
        
        let firstPumpfunBoost = null;
        
        // First pass: Find all pumpfun tokens and mark them as processed
        // Also identify the first (most recent) one to emit
        for (const boost of boosts) {
            if (boost.chainId !== 'solana') {
                continue;
            }
            
            // Check if it's a pumpfun token
            const tokenData = await isPumpfunToken(boost.tokenAddress);
            if (tokenData) {
                // Mark ALL pumpfun tokens as processed (so regular polling won't process them)
                processedBoosts.add(boost.tokenAddress);
                
                // Store the first one we find (most recent) to emit
                if (!firstPumpfunBoost) {
                    firstPumpfunBoost = {
                        boost: boost,
                        tokenData: tokenData
                    };
                }
            }
        }
        
        // Only emit the first (most recent) pumpfun Boost
        if (firstPumpfunBoost) {
            const { boost, tokenData } = firstPumpfunBoost;
            console.log(`[Boost Startup] Found most recent pumpfun Boost: ${tokenData.name} (${tokenData.symbol}) - ${boost.tokenAddress}`);
            
            // Get marketcap from tokenData
            const marketCapSol = tokenData.usd_market_cap_sol || 0;
            const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
            const athMarketCap = tokenData.ath_market_cap || 0;
            
            // Emit the event
            io.emit('token:event', {
                type: 'boost',
                token: {
                    mint: boost.tokenAddress,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || boost.icon || null,
                    header: boost.header || null,
                    url: boost.url,
                    description: boost.description || '',
                    links: boost.links || [],
                    amount: boost.amount || 0,
                    totalAmount: boost.totalAmount || 0,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                }
            });
        }
    } catch (error) {
        console.error('Error checking Boost events at startup:', error.message);
    }
}

/**
 * Check for new Boost events
 */
async function checkBoostEvents() {
    try {
        const response = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1', {
            timeout: 10000
        });
        
        if (!response.data) {
            return;
        }
        
        // Boost API returns an object, not an array
        let boosts = [];
        if (Array.isArray(response.data)) {
            boosts = response.data;
        } else if (response.data && typeof response.data === 'object') {
            // If it's a single object, wrap it in an array
            boosts = [response.data];
        } else {
            return;
        }
        
        for (const boost of boosts) {
            // Skip if already processed (use tokenAddress as key)
            if (processedBoosts.has(boost.tokenAddress)) {
                continue;
            }
            
            // Only process Solana tokens
            if (boost.chainId !== 'solana') {
                continue;
            }
            
            // Check if it's a pumpfun token
            const tokenData = await isPumpfunToken(boost.tokenAddress);
            if (!tokenData) {
                continue;
            }
            
            // Mark as processed
            processedBoosts.add(boost.tokenAddress);
            
            // Get marketcap from tokenData
            const marketCapSol = tokenData.usd_market_cap_sol || 0;
            const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
            const athMarketCap = tokenData.ath_market_cap || 0;
            
            // Emit Boost event to all connected clients
            io.emit('token:event', {
                type: 'boost',
                token: {
                    mint: boost.tokenAddress,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || boost.icon || null,
                    header: boost.header || null,
                    url: boost.url,
                    description: boost.description || '',
                    links: boost.links || [],
                    amount: boost.amount || 0,
                    totalAmount: boost.totalAmount || 0,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                }
            });
            
            console.log(`[Boost Event] ${tokenData.name} (${tokenData.symbol}) - ${boost.tokenAddress} - Amount: ${boost.amount}/${boost.totalAmount}`);
        }
    } catch (error) {
        console.error('Error checking Boost events:', error.message);
    }
}

/**
 * Check for most recent pumpfun Ads at startup
 */
async function checkAdsEventsAtStartup() {
    try {
        const response = await axios.get('https://api.dexscreener.com/ads/latest/v1', {
            timeout: 10000
        });
        
        if (!response.data) {
            return;
        }
        
        // Ads API returns an array
        let ads = [];
        if (Array.isArray(response.data)) {
            ads = response.data;
        } else {
            return;
        }
        
        let firstPumpfunAd = null;
        
        // First pass: Find all pumpfun tokens and mark them as processed
        // Also identify the first (most recent) one to emit
        for (const ad of ads) {
            if (ad.chainId !== 'solana') {
                continue;
            }
            
            // Check if it's a pumpfun token
            const tokenData = await isPumpfunToken(ad.tokenAddress);
            if (tokenData) {
                // Mark ALL pumpfun tokens as processed (so regular polling won't process them)
                const adKey = `${ad.tokenAddress}-${ad.date}`;
                processedAds.add(adKey);
                
                // Store the first one we find (most recent) to emit
                if (!firstPumpfunAd) {
                    firstPumpfunAd = {
                        ad: ad,
                        tokenData: tokenData
                    };
                }
            }
        }
        
        // Only emit the first (most recent) pumpfun Ads
        if (firstPumpfunAd) {
            const { ad, tokenData } = firstPumpfunAd;
            console.log(`[Ads Startup] Found most recent pumpfun Ads: ${tokenData.name} (${tokenData.symbol}) - ${ad.tokenAddress}`);
            
            // Get marketcap from tokenData
            const marketCapSol = tokenData.usd_market_cap_sol || 0;
            const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
            const athMarketCap = tokenData.ath_market_cap || 0;
            
            // Get header from ad, or fetch from DexScreener search API if not available
            let header = ad.header || null;
            if (!header) {
                header = await getDexScreenerHeader(ad.tokenAddress);
            }
            
            // Emit the event
            io.emit('token:event', {
                type: 'ads',
                token: {
                    mint: ad.tokenAddress,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || ad.icon || null,
                    header: header,
                    url: ad.url,
                    date: ad.date,
                    type: ad.type || '',
                    description: ad.description || '',
                    durationHours: ad.durationHours || 0,
                    impressions: ad.impressions || 0,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                }
            });
        }
    } catch (error) {
        console.error('Error checking Ads events at startup:', error.message);
    }
}

/**
 * Check for new Ads events
 */
async function checkAdsEvents() {
    try {
        const response = await axios.get('https://api.dexscreener.com/ads/latest/v1', {
            timeout: 10000
        });
        
        if (!response.data) {
            return;
        }
        
        // Ads API returns an array
        let ads = [];
        if (Array.isArray(response.data)) {
            ads = response.data;
        } else {
            return;
        }
        
        for (const ad of ads) {
            // Skip if already processed (use tokenAddress + date as key for uniqueness)
            const adKey = `${ad.tokenAddress}-${ad.date}`;
            if (processedAds.has(adKey)) {
                continue;
            }
            
            // Only process Solana tokens
            if (ad.chainId !== 'solana') {
                continue;
            }
            
            // Check if it's a pumpfun token
            const tokenData = await isPumpfunToken(ad.tokenAddress);
            if (!tokenData) {
                continue;
            }
            
            // Mark as processed
            processedAds.add(adKey);
            
            // Get marketcap from tokenData
            const marketCapSol = tokenData.usd_market_cap_sol || 0;
            const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
            const athMarketCap = tokenData.ath_market_cap || 0;
            
            // Get header from ad, or fetch from DexScreener search API if not available
            let header = ad.header || null;
            if (!header) {
                header = await getDexScreenerHeader(ad.tokenAddress);
            }
            
            // Emit Ads event to all connected clients
            io.emit('token:event', {
                type: 'ads',
                token: {
                    mint: ad.tokenAddress,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || ad.icon || null,
                    header: header,
                    url: ad.url,
                    date: ad.date,
                    type: ad.type || '',
                    description: ad.description || '',
                    durationHours: ad.durationHours || 0,
                    impressions: ad.impressions || 0,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                }
            });
            
            console.log(`[Ads Event] ${tokenData.name} (${tokenData.symbol}) - ${ad.tokenAddress} - Duration: ${ad.durationHours}h, Impressions: ${ad.impressions}, Header: ${header || 'none'}`);
        }
    } catch (error) {
        console.error('Error checking Ads events:', error.message);
    }
}

/**
 * Check for most recent pumpfun live stream at startup
 */
async function checkLiveStreamEventsAtStartup() {
    console.log('[Live Stream Startup] ⚡ FUNCTION CALLED - Checking for top stream at startup...');
    try {
        console.log('[Live Stream Startup] Making API request to pump.fun...');
        const response = await axios.get('https://frontend-api-v3.pump.fun/coins/currently-live', {
            headers: {
                'Accept': 'application/json',
            },
            timeout: 10000
        });
        
        console.log('[Live Stream Startup] API response received, data:', response.data ? (Array.isArray(response.data) ? `${response.data.length} streams` : 'not an array') : 'no data');
        
        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
            console.log('[Live Stream Startup] No streams found at startup');
            return;
        }
        
        // Find the token with the most participants
        let topStream = null;
        let maxParticipants = 0;
        
        for (const stream of response.data) {
            // Check for participants field (could be num_participants or participants)
            const participants = stream.num_participants || stream.participants || 0;
            console.log('[Live Stream Startup] Stream found:', stream.mint, 'participants:', participants);
            if (participants > maxParticipants && participants > 0) {
                maxParticipants = participants;
                topStream = stream;
            }
        }
        
        if (topStream && topStream.mint) {
            console.log('[Live Stream Startup] Top stream found:', topStream.mint, 'with', maxParticipants, 'participants');
            // Get token data to verify it's a pumpfun token and get marketcap
            const tokenData = await getToken(topStream.mint);
            if (tokenData) {
                currentTopStreamMint = topStream.mint;
                currentTopStreamParticipants = maxParticipants;
                currentTopStreamThumbnail = topStream.thumbnail || null;
                console.log(`[Live Stream Startup] Found top stream: ${tokenData.name || 'Unknown'} (${tokenData.symbol || 'UNKNOWN'}) - ${topStream.mint} - ${maxParticipants} viewers`);
                
                // Emit the current top stream to connected clients at startup
                const marketCapSol = tokenData.usd_market_cap_sol || 0;
                const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
                const athMarketCap = tokenData.ath_market_cap || 0;
                
                const streamData = {
                    mint: topStream.mint,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || null,
                    thumbnail: currentTopStreamThumbnail,
                    participants: maxParticipants,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                };
                
                if (io && io.sockets.sockets.size > 0) {
                    try {
                        io.emit('top-live-stream:update', streamData);
                        console.log('[Live Stream Startup] ✅ Emitted top stream at startup');
                    } catch (emitError) {
                        console.error('[Live Stream Startup] ❌ ERROR emitting top stream:', emitError);
                    }
                }
            } else {
                console.log('[Live Stream Startup] Token data not found for mint:', topStream.mint);
            }
        } else {
            console.log('[Live Stream Startup] No valid top stream found at startup');
        }
    } catch (error) {
        console.error('[Live Stream Startup] Error checking Live Stream events at startup:', error.message);
        console.error('[Live Stream Startup] Error stack:', error.stack);
    }
}

/**
 * Check for new Live Stream events (when a token becomes the top stream)
 */
async function checkLiveStreamEvents() {
    console.log('[Live Stream Check] ⚡ FUNCTION CALLED - Starting live stream check...');
    try {
        console.log('[Live Stream Check] Making API request to pump.fun...');
        const response = await axios.get('https://frontend-api-v3.pump.fun/coins/currently-live', {
            headers: {
                'Accept': 'application/json',
            },
            timeout: 10000
        });
        
        console.log('[Live Stream Check] API response received, data:', response.data ? (Array.isArray(response.data) ? `${response.data.length} streams` : 'not an array') : 'no data');
        
        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
            console.log('[Live Stream Check] No streams found or invalid response');
            return;
        }
        
        // Find the token with the most participants
        let topStream = null;
        let maxParticipants = 0;
        
        for (const stream of response.data) {
            // Check for participants field (could be num_participants or participants)
            const participants = stream.num_participants || stream.participants || 0;
            console.log('[Live Stream Check] Stream:', stream.mint ? stream.mint.substring(0, 8) : 'no mint', 'participants:', participants, 'has mint:', !!stream.mint);
            if (participants > maxParticipants && participants > 0) {
                maxParticipants = participants;
                topStream = stream;
            }
        }
        
        console.log('[Live Stream Check] Top stream found:', topStream ? `mint: ${topStream.mint}, participants: ${maxParticipants}` : 'none');
        console.log('[Live Stream Check] Current top stream mint:', currentTopStreamMint);
        
        if (!topStream && response.data.length > 0) {
            console.log('[Live Stream Check] WARNING: Streams found but none have participants > 0. Sample stream:', JSON.stringify(response.data[0], null, 2));
        }
        
        // If there's a top stream, always update clients with current top stream
        if (topStream && topStream.mint) {
            // Get token data to verify it's a pumpfun token and get marketcap
            console.log('[Live Stream Check] Fetching token data for:', topStream.mint);
            const tokenData = await getToken(topStream.mint);
            if (tokenData) {
                console.log('[Live Stream Check] Token data received:', tokenData.name || 'Unknown');
                
                // Update current top stream tracking
                currentTopStreamMint = topStream.mint;
                currentTopStreamParticipants = maxParticipants;
                currentTopStreamThumbnail = topStream.thumbnail || null;
                
                // Get marketcap from tokenData
                const marketCapSol = tokenData.usd_market_cap_sol || 0;
                const marketCapUSD = tokenData.usd_market_cap || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
                const athMarketCap = tokenData.ath_market_cap || 0;
                
                // Always emit current top stream to all connected clients
                const streamData = {
                    mint: topStream.mint,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    image: tokenData.image_uri || null,
                    thumbnail: currentTopStreamThumbnail,
                    participants: maxParticipants,
                    marketCapSol: marketCapSol,
                    marketCapUSD: marketCapUSD,
                    athMarketCap: athMarketCap
                };
                
                // Check if io is defined
                if (!io) {
                    console.error('[Live Stream Check] ❌ ERROR: io is not defined!');
                    return;
                }
                
                const connectedClients = io.sockets.sockets.size;
                console.log('[Live Stream Check] Emitting top stream update to', connectedClients, 'clients');
                
                if (connectedClients > 0) {
                    try {
                        io.emit('top-live-stream:update', streamData);
                        console.log(`[Live Stream Check] ✅ Emitted top stream update: ${tokenData.name || 'Unknown'} (${tokenData.symbol || 'UNKNOWN'}) - ${maxParticipants} viewers`);
                    } catch (emitError) {
                        console.error('[Live Stream Check] ❌ ERROR emitting top stream update:', emitError);
                        console.error('[Live Stream Check] Error stack:', emitError.stack);
                    }
                }
            } else {
                console.log('[Live Stream Check] ❌ Token data not found for mint:', topStream.mint);
            }
        } else {
            // No top stream found - emit null to clear the slot
            console.log('[Live Stream Check] No top stream found, clearing top stream slot');
            currentTopStreamMint = null;
            currentTopStreamParticipants = 0;
            currentTopStreamThumbnail = null;
            
            if (io && io.sockets.sockets.size > 0) {
                try {
                    io.emit('top-live-stream:update', null);
                    console.log('[Live Stream Check] ✅ Emitted top stream clear (no stream)');
                } catch (emitError) {
                    console.error('[Live Stream Check] ❌ ERROR emitting top stream clear:', emitError);
                }
            }
        }
    } catch (error) {
        console.error('[Live Stream Check] Error checking Live Stream events:', error.message);
        console.error('[Live Stream Check] Error stack:', error.stack);
    }
}

/**
 * Check for OG event (3+ tokens with same Twitter link)
 * @param {Object} token - The token to check
 */
async function checkOGEvent(token) {
    if (!token || !token.twitter || !token.mint || !token.created) {
        return;
    }
    
    try {
        // Normalize twitter URL (extract base URL without status ID)
        const twitterUrl = token.twitter;
        const twitterMatch = twitterUrl.match(/^(https?:\/\/(?:twitter\.com|x\.com)\/[^\/]+)/i);
        if (!twitterMatch) {
            return; // Invalid Twitter URL format
        }
        
        const twitterBase = twitterMatch[1].toLowerCase();
        
        // If this Twitter address has already triggered an OG event, skip it entirely
        if (triggeredOGTwitter.has(twitterBase)) {
            return;
        }
        
        const currentTime = token.created;
        const OG_TIME_WINDOW = 30000;
        
        // Initialize or get existing OG data for this Twitter link
        if (!processedOGs.has(twitterBase)) {
            processedOGs.set(twitterBase, []);
        }
        
        const ogTokens = processedOGs.get(twitterBase);
        
        // Check if this token is already tracked
        const existingTokenIndex = ogTokens.findIndex(t => t.mint === token.mint);
        if (existingTokenIndex === -1) {
            // Add this token with its creation timestamp
            ogTokens.push({
                mint: token.mint,
                created: currentTime
            });
        } else {
            // Update the creation time if it changed
            ogTokens[existingTokenIndex].created = currentTime;
        }
        
        // Clean up tokens older than 10 seconds (keep a reasonable window for checking)
        const now = Date.now();
        const recentTokens = ogTokens.filter(t => (now - t.created) <= 10000);
        processedOGs.set(twitterBase, recentTokens);
        
        // Check if there's a 3-second window that contains 3+ tokens
        // Sort tokens by creation time
        recentTokens.sort((a, b) => a.created - b.created);
        
        // For each token, check if there are 2 other tokens within 3 seconds
        for (let i = 0; i < recentTokens.length; i++) {
            const baseToken = recentTokens[i];
            const windowStart = baseToken.created;
            const windowEnd = baseToken.created + OG_TIME_WINDOW;
            
            // Find all tokens in this 3-second window
            const tokensInWindow = recentTokens.filter(t => 
                t.created >= windowStart && t.created <= windowEnd
            );
            
            // If we have 3+ tokens in this window, trigger OG event
            if (tokensInWindow.length >= 3) {
                // The OG token is the first one in the window (oldest)
                const ogMint = tokensInWindow[0].mint;
                
                // Check if we've already emitted an OG event for this specific group
                // Use a key based on the OG mint and the tokens in the window to prevent duplicates
                const windowKey = tokensInWindow.map(t => t.mint).sort().join('-');
                const emissionKey = `og-${ogMint}-${windowKey}`;
                
                if (!triggeredUserAlerts.has(emissionKey)) {
                    triggeredUserAlerts.add(emissionKey);
                    
                    // Mark this Twitter address as having triggered an OG event
                    triggeredOGTwitter.add(twitterBase);
                    
                    // Get token data from storage or cache
                    let ogToken = STORE_TOKENS ? tokens.get(ogMint) : tokenCache.get(ogMint);
                    if (!ogToken) {
                        // Fallback: try to get from the tokenCache or use current token
                        ogToken = tokenCache.get(ogMint) || token;
                    }
                    
                    // Try to get latest token data from API for ATH and other info
                    let tokenData = null;
                    try {
                        tokenData = await getToken(ogMint);
                    } catch (error) {
                        // If API call fails, continue with cached data
                    }
                    
                    // Get marketcap from token
                    const marketCapSol = ogToken.marketCapSol || ogToken.value || 0;
                    const marketCapUSD = ogToken.marketCapUSD || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
                    
                    // Get ATH from token data - check multiple possible fields
                    let athMarketCap = 0;
                    if (tokenData) {
                        // Check various possible ATH fields in API response
                        athMarketCap = tokenData.ath_market_cap || 
                                      tokenData.ath_marketcap || 
                                      tokenData.athMarketCap || 
                                      tokenData.athMarketcap ||
                                      (tokenData.ath && tokenData.ath.market_cap) ||
                                      (tokenData.ath && tokenData.ath.marketCap) ||
                                      0;
                    }
                    // Fallback to cached token ATH if API doesn't have it
                    if (!athMarketCap && ogToken) {
                        athMarketCap = ogToken.athMarketCap || ogToken.ath_market_cap || ogToken.allTimeHigh || 0;
                    }
                    
                    // Emit OG event
                    io.emit('token:event', {
                        type: 'og',
                        token: {
                            mint: ogToken.mint,
                            name: ogToken.name || tokenData?.name || 'Unknown',
                            symbol: ogToken.symbol || tokenData?.symbol || 'UNKNOWN',
                            image: ogToken.image || tokenData?.image_uri || null,
                            twitter: ogToken.twitter || tokenData?.twitter || null,
                            tokenCount: tokensInWindow.length,
                            marketCapSol: marketCapSol,
                            marketCapUSD: marketCapUSD,
                            athMarketCap: athMarketCap
                        }
                    });
                    
                    console.log(`[OG Event] ${ogToken.name} (${ogToken.symbol}) - ${tokensInWindow.length} tokens created within 3 seconds with Twitter: ${twitterBase}`);
                    
                    // Only emit once per window, so break after finding the first valid window
                    break;
                }
            }
        }
    } catch (error) {
        console.error(`Error checking OG event for token ${token.mint}:`, error.message);
    }
}

/**
 * Fetch the metadata URI for a token and retrieve the data from that URI
 * @param {string} mint - The token mint address
 * @returns {Promise<Object|null>} The metadata data from the URI, or null if not found
 */
async function getUri(mint) {
    try {
        const tokenData = await getToken(mint);
        if (!tokenData || !tokenData.metadata_uri) {
            return null;
        }
        
        const originalUri = tokenData.metadata_uri;
        
        // List of IPFS gateway alternatives
        const ipfsGateways = [
            'https://ipfs.io/ipfs/',
            'https://cloudflare-ipfs.com/ipfs/',
            'https://gateway.pinata.cloud/ipfs/',
            'https://dweb.link/ipfs/',
            'https://ipfs.filebase.io/ipfs/',
            'https://cf-ipfs.com/ipfs/',
            'https://ipfs.eth.aragon.network/ipfs/'
        ];
        
        // Check if it's an IPFS URI that can use alternatives
        let ipfsHash = null;
        for (const gateway of ipfsGateways) {
            if (originalUri.includes(gateway)) {
                ipfsHash = originalUri.replace(gateway, '');
                break;
            }
        }
        
        // If it's an IPFS URI, try alternatives if the original fails
        if (ipfsHash) {
            const isIpfsIo = originalUri.includes('https://ipfs.io/ipfs/');
            const pinataGateway = 'https://gateway.pinata.cloud/ipfs/';
            
            // If original is ipfs.io, try Pinata first, then original, then other alternatives
            if (isIpfsIo) {
                const urisToTry = [
                    pinataGateway + ipfsHash,  // Try Pinata first
                    originalUri,               // Then try original ipfs.io
                    ...ipfsGateways
                        .filter(g => !originalUri.includes(g) && !g.includes('gateway.pinata.cloud'))
                        .map(g => g + ipfsHash) // Then try other alternatives
                ];
                
                for (const uri of urisToTry) {
                    try {
                        const response = await axios.get(uri, { timeout: 5000 });
                        return response.data;
                    } catch (error) {
                        // If it's the last URI and it fails, throw the error
                        if (uri === urisToTry[urisToTry.length - 1]) {
                            throw error;
                        }
                        // Otherwise, try the next gateway
                        continue;
                    }
                }
            } else {
                // If original is not ipfs.io, try original first, then alternatives (with Pinata as fallback)
                try {
                    const response = await axios.get(originalUri, { timeout: 5000 });
                    return response.data;
                } catch (originalError) {
                    // If original fails, try alternative gateways (prioritize Pinata)
                    const alternativeGateways = [
                        pinataGateway,
                        ...ipfsGateways.filter(g => !originalUri.includes(g) && !g.includes('gateway.pinata.cloud'))
                    ];
                    
                    for (const gateway of alternativeGateways) {
                        try {
                            const alternativeUri = gateway + ipfsHash;
                            const response = await axios.get(alternativeUri, { timeout: 5000 });
                            return response.data;
                        } catch (error) {
                            // If it's the last gateway and it fails, throw the error
                            if (gateway === alternativeGateways[alternativeGateways.length - 1]) {
                                throw originalError; // Throw the original error if all alternatives fail
                            }
                            // Otherwise, try the next gateway
                            continue;
                        }
                    }
                }
            }
        } else {
            // For non-IPFS URIs, just try the original
            const response = await axios.get(originalUri);
            return response.data;
        }
    } catch (error) {
        throw error;
    }
}

/**
 * Extract Twitter username from a Twitter URL
 * Handles formats like:
 * - x.com/username/status/...
 * - twitter.com/username/status/...
 * - https://x.com/username
 * - https://twitter.com/username
 * @param {string} twitterUrl - The Twitter URL
 * @returns {string|null} The username or null if not found
 */
function extractTwitterUsername(twitterUrl) {
    if (!twitterUrl) return null;
    
    // Remove protocol if present
    let url = twitterUrl.replace(/^https?:\/\//, '').trim();
    
    // Match patterns: x.com/username or twitter.com/username (with optional /status/...)
    const patterns = [
        /^(?:www\.)?(?:x|twitter)\.com\/([^\/\?]+)/i,  // x.com/username or twitter.com/username
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1].toLowerCase();
        }
    }
    
    return null;
}

/**
 * Check if a token matches an alert condition
 * @param {Object} alert - The alert configuration
 * @param {Object} token - The token data
 * @returns {Promise<boolean>} True if alert should trigger
 */
async function checkAlert(alert, token) {
    if (!alert.enabled) return false;

    switch(alert.type) {
        case 'ticker-exact':
            return token.symbol && token.symbol.toLowerCase() === alert.value.toLowerCase();
        
        case 'ticker-contains':
            return token.symbol && token.symbol.toLowerCase().includes(alert.value.toLowerCase());
        
        case 'name-exact':
            return token.name && token.name.toLowerCase() === alert.value.toLowerCase();
        
        case 'name-contains':
            return token.name && token.name.toLowerCase().includes(alert.value.toLowerCase());
        
        case 'deployer-match':
            return token.deployer && token.deployer.toLowerCase() === alert.value.toLowerCase();
        
        case 'deployer-marketcap':
            // Check if this token's marketcap (in USD) meets the threshold
            const marketCapSol = token.marketCapSol || token.value || 0;
            if (!marketCapSol || !solanaPriceUSD || alert.threshold === undefined) {
                return false;
            }
            const marketCapUSD = marketCapSol * solanaPriceUSD;
            return marketCapUSD >= alert.threshold;
        
        case 'twitter-handle':
            if (!token.twitter) return false;
            const twitterUsername = extractTwitterUsername(token.twitter);
            if (!twitterUsername) return false;
            // Match against the provided username (case-insensitive)
            return twitterUsername === alert.value.toLowerCase();
        
        case 'website-contains':
            if (!token.website) return false;
            // Case-insensitive contains check
            return token.website.toLowerCase().includes(alert.value.toLowerCase());
        
        default:
            return false;
    }
}

/**
 * Check all alerts for a token and trigger matching ones
 * @param {Object} token - The token data
 */
async function checkAlertsForToken(token) {
    for (const alert of alerts.values()) {
        try {
            const shouldTrigger = await checkAlert(alert, token);
            if (shouldTrigger) {
                const tokenData = prepareTokenForBroadcast(token);
                const alertData = {
                    alertId: alert.id,
                    token: tokenData
                };
                console.log(`🚨 Alert triggered: ${alert.id} - Token: ${token.name} (${token.symbol})`);
                console.log(`Emitting alert:triggered to ${io.sockets.sockets.size} clients`);
                io.emit('alert:triggered', alertData);
            }
        } catch (error) {
            console.error(`Error checking alert ${alert.id}:`, error.message);
        }
    }
}

/**
 * Check user alerts from profiles and send Telegram notifications
 * @param {Object} token - The token data
 */
async function checkUserAlertsForToken(token) {
    try {
        // Always read fresh client data to ensure we have latest alerts
        const clients = await readClients();
        
        if (!token || !token.mint) {
            console.warn('checkUserAlertsForToken: Invalid token data (missing mint)');
            return;
        }
        
        for (const [username, user] of Object.entries(clients)) {
            // Skip if user doesn't have Telegram linked
            if (!user.telegramLinked || !user.telegramChatId) {
                continue;
            }
            
            // Skip if user has no alerts
            if (!user.alerts || !Array.isArray(user.alerts) || user.alerts.length === 0) {
                continue;
            }
            
            // Check each alert for this user
            for (const alert of user.alerts) {
                try {
                    if (!alert.enabled) continue;
                    
                    const shouldTrigger = await checkAlert(alert, token);
                    if (shouldTrigger) {
                        // Create unique key for this user-mint-alert combination
                        // This ensures we only prevent duplicates for the same mint address
                        const alertKey = `${username}-${token.mint}-${alert.id}`;
                        
                        // Only send notification if we haven't already sent it for this exact mint-alert combination
                        if (!triggeredUserAlerts.has(alertKey)) {
                            triggeredUserAlerts.add(alertKey);
                            
                            console.log(`[Alert Check] Match found: User ${username}, Alert ${alert.id} (${alert.type}), Token ${token.mint} (${token.name || 'Unknown'})`);
                            
                            // Format alert description
                            const alertDesc = getAlertDescription(alert);
                            const marketCapSol = token.marketCapSol || token.value || 0;
                            const marketCapUSD = marketCapSol * solanaPriceUSD;
                            const marketCapFormatted = marketCapUSD < 1000 
                                ? `$${marketCapUSD.toFixed(2)}` 
                                : marketCapUSD < 1000000 
                                    ? `$${(marketCapUSD / 1000).toFixed(1)}K`
                                    : `$${(marketCapUSD / 1000000).toFixed(2)}M`;
                            
                            // Create message
                            const message = `🚨 Alert Matched!\n\n` +
                                `Alert: ${alertDesc}\n\n` +
                                `Token: ${token.name || 'Unknown'} (${token.symbol || 'UNKNOWN'})\n` +
                                `Market Cap: ${marketCapFormatted}\n` +
                                `Pump.Fun: https://pump.fun/${token.mint}`;
                            
                            // Create inline keyboard with buttons
                            const inlineKeyboard = {
                                inline_keyboard: [
                                    [
                                        { text: 'Pump.Fun', url: `https://pump.fun/${token.mint}` },
                                        { text: 'Pump Advanced', url: `https://pump.fun/advanced/coin/${token.mint}` }
                                    ],
                                    [
                                        { text: 'GMGN', url: `https://gmgn.ai/sol/token/${token.mint}` },
                                        { text: 'Axiom', url: `https://axiom.trade/t/${token.mint}` }
                                    ]
                                ]
                            };
                            
                            // Send Telegram message with inline keyboard
                            await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                                chat_id: user.telegramChatId,
                                text: message,
                                parse_mode: 'HTML',
                                disable_web_page_preview: false,
                                reply_markup: inlineKeyboard
                            }).catch(err => {
                                console.error(`Error sending Telegram message to ${username}:`, err.message);
                            });
                            
                            console.log(`📱 Telegram alert sent to ${username} for token ${token.name} (${token.symbol}) - Alert: ${alert.id}`);
                        } else {
                            console.log(`[Alert Check] Duplicate prevented: ${alertKey} already triggered`);
                        }
                        // Continue checking other alerts - don't break, allow multiple alerts to trigger
                    }
                } catch (error) {
                    console.error(`Error checking alert ${alert.id} for user ${username}:`, error.message);
                }
            }
        }
    } catch (error) {
        console.error('Error checking user alerts:', error);
    }
}

/**
 * Get a human-readable description of an alert
 * @param {Object} alert - The alert configuration
 * @returns {string} Description of the alert
 */
function getAlertDescription(alert) {
    switch(alert.type) {
        case 'ticker-exact':
            return `Ticker is exactly "${alert.value}"`;
        case 'ticker-contains':
            return `Ticker contains "${alert.value}"`;
        case 'name-exact':
            return `Name is exactly "${alert.value}"`;
        case 'name-contains':
            return `Name contains "${alert.value}"`;
        case 'deployer-match':
            return `Developer wallet matches "${alert.value.substring(0, 8)}..."`;
        case 'deployer-marketcap':
            return `Developer has token above $${alert.threshold?.toLocaleString() || 'N/A'}`;
        case 'twitter-handle':
            return `Twitter handle matches "${alert.value}"`;
        case 'website-contains':
            return `Website contains "${alert.value}"`;
        default:
            return `${alert.type}: ${alert.value || 'N/A'}`;
    }
}

// Function to reconnect WebSocket
function reconnectWebSocket() {
    console.log('Reconnecting WebSocket...');
    
    // Clear existing heartbeat interval
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    
    // Clear reconnect timeout if exists
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    
    // Remove all event listeners from old WebSocket to prevent memory leaks
    if (ws) {
        ws.removeAllListeners();
        // Close existing connection if open or connecting
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
    }
    
    // Small delay before reconnecting to avoid rapid reconnection loops
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        // Create new WebSocket connection
        ws = new WebSocket(WS_URL);
        setupWebSocketHandlers();
    }, 1000); // 1 second delay
}

// Function to setup WebSocket event handlers
function setupWebSocketHandlers() {
ws.on('open', function open() {
        console.log('WebSocket connected');
        
        // Reset last message time
        lastMessageTime = Date.now();
        
        // Subscribe to new token events
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));

        // Subscribe to migration events
        ws.send(JSON.stringify({ method: "subscribeMigration" }));

        // Start heartbeat check
        startHeartbeat();
    });

    ws.on('error', function error(err) {
        console.error('WebSocket error:', err.message);
    });

    ws.on('close', function close(code, reason) {
        console.log(`WebSocket closed (code: ${code}, reason: ${reason || 'none'})`);
        
        // Stop heartbeat check
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        // Automatically attempt to reconnect if not already reconnecting
        // Only reconnect if it was an unexpected close (not a manual close)
        if (code !== 1000) { // 1000 = normal closure
            console.log('WebSocket closed unexpectedly, attempting to reconnect...');
            reconnectWebSocket();
        }
    });

    ws.on('message', function message(data) {
        // Update last message time on any message (trades or creates)
        lastMessageTime = Date.now();

    let response = JSON.parse(data)

    // Subscribing to trades on tokens

    if (response.txType === 'create' && response.pool === 'pump') {
        // Check if this token was created by the launch developer wallet
        if (response.traderPublicKey === LAUNCH_DEVELOPER_WALLET && launchToken === null) {
            launchToken = response.mint;
            console.log(`🚀 LAUNCH TOKEN SET: ${response.name} (${response.symbol}) - ${response.mint}`);
        }
        
        // Create initial token entry from WebSocket data
        const tokenData = {
            mint: response.mint,
            value: response.marketCapSol,
            name: response.name,
            symbol: response.symbol,
            deployer: response.traderPublicKey,
            devBuy: response.initialBuy,
            uri: response.uri,
            created: Date.now(), // Create timestamp
            description: null,
            image: null,
            twitter: null,
            website: null,
            telegram: null,
            // Trade tracking fields
            marketCapSol: response.marketCapSol,
            allTimeHigh: response.marketCapSol, // Initialize ATH to current marketcap
            totalBuys: 0,
            totalSells: 0,
            buyVolume: 0,
            sellVolume: 0,
            uniqueBuyers: new Set(),
            tradesPerMinute: [] // Array of { minute: timestamp, buys: count, sells: count }
        };

        // Always store in tokenCache for metadata updates (even when STORE_TOKENS is false)
        tokenCache.set(response.mint, { ...tokenData });
        tokenData._status = 'PARTIAL'; // Track status to prevent duplicate logs
        
        // Store tokens and subscribe to trades only if STORE_TOKENS is enabled
        if (STORE_TOKENS) {
let payload = {
                method: "subscribeTokenTrade",
                keys: [`${response.mint}`] // array of token CAs to watch
  }
ws.send(JSON.stringify(payload));

            tokens.set(response.mint, tokenData);
            console.log(`Token [PARTIAL]: ${response.name} (${response.symbol}) - ${response.mint}`);
            
            // Initialize last transaction time for new token
            lastTransactionTime.set(response.mint, Date.now());
            
            // Remove oldest tokens if we've exceeded the limit
            removeOldestTokens();
        } else {
            // Just log when not storing
            console.log(`Token [PARTIAL]: ${response.name} (${response.symbol}) - ${response.mint}`);
        }

        // Always broadcast new token to all connected clients
        broadcastNewToken(tokenData);
        
        // Emit backend operation for demo
        io.emit('backend:operation', {
            type: 'token-created',
            message: `Token created: ${response.name} (${response.symbol})`,
            mint: response.mint.substring(0, 8),
            marketcap: response.marketCapSol,
            timestamp: Date.now()
        });
        
        // Check user alerts and send Telegram notifications
        // Add a small delay to allow metadata to start loading, then check again when metadata is available
        checkUserAlertsForToken(tokenData).catch(error => {
            console.error(`Error checking user alerts for token ${response.mint}:`, error.message);
        });
        
        // Note: OG event will be checked when twitter metadata is updated
        
        // Also check alerts again after a delay to catch metadata-dependent alerts
        // Metadata is fetched asynchronously, so we need to re-check when it becomes available
        setTimeout(() => {
            // Re-read token from storage/cache to get updated metadata
            const updatedToken = STORE_TOKENS ? tokens.get(response.mint) : tokenCache.get(response.mint);
            if (updatedToken) {
                checkUserAlertsForToken(updatedToken).catch(error => {
                    console.error(`Error checking user alerts (delayed) for token ${response.mint}:`, error.message);
                });
            }
        }, 5000); // Check again after 5 seconds when metadata should be available

        // Helper function to update token and log completion
        // Works even when STORE_TOKENS is false by using tokenCache
        const updateTokenFromUriData = async (uriData) => {
            // Get token from storage or cache
            let token = STORE_TOKENS ? tokens.get(response.mint) : tokenCache.get(response.mint);
            
            // If token doesn't exist, try to fetch basic info from API
            if (!token) {
                try {
                    const apiTokenData = await getToken(response.mint);
                    if (apiTokenData) {
                        // Create minimal token from API data
                        token = {
                            mint: response.mint,
                            value: apiTokenData.usd_market_cap_sol || 0,
                            name: apiTokenData.name || 'Unknown',
                            symbol: apiTokenData.symbol || 'UNKNOWN',
                            deployer: apiTokenData.creator || null,
                            devBuy: null,
                            uri: apiTokenData.metadata_uri || null,
                            created: Date.now(),
                            description: null,
                            image: null,
                            twitter: null,
                            website: null,
                            telegram: null,
                            banner_uri: apiTokenData.banner_uri || null,
                            marketCapSol: apiTokenData.usd_market_cap_sol || 0,
                            allTimeHigh: apiTokenData.usd_market_cap_sol || 0, // Initialize ATH
                            totalBuys: 0,
                            totalSells: 0,
                            buyVolume: 0,
                            sellVolume: 0,
                            uniqueBuyers: new Set(),
                            tradesPerMinute: []
                        };
                        // Store in cache for future updates
                        tokenCache.set(response.mint, token);
                    } else {
                        // Can't create token, skip update
                        return;
                    }
                } catch (error) {
                    // Failed to fetch token, skip update
                    return;
                }
            }

            let hasChanges = false;
            let twitterUpdated = false;
            let websiteUpdated = false;
            if (uriData.image && token.image !== uriData.image) {
                token.image = uriData.image;
                hasChanges = true;
            }
            if (uriData.description !== undefined && token.description !== uriData.description) {
                token.description = uriData.description;
                hasChanges = true;
            }
            if (uriData.twitter !== undefined && token.twitter !== uriData.twitter) {
                token.twitter = uriData.twitter;
                hasChanges = true;
                twitterUpdated = true;
                // Check for OG event when twitter is updated
                if (uriData.twitter) {
                    checkOGEvent(token).catch(error => {
                        console.error(`Error checking OG event for token ${token.mint}:`, error.message);
                    });
                }
            }
            if (uriData.website !== undefined && token.website !== uriData.website) {
                token.website = uriData.website;
                hasChanges = true;
                websiteUpdated = true;
            }
            if (uriData.telegram !== undefined && token.telegram !== uriData.telegram) {
                token.telegram = uriData.telegram;
                hasChanges = true;
            }
            // Note: banner_uri is not in URI metadata, it comes from getToken API only

            if (hasChanges) {
                // Update both storage and cache
                if (STORE_TOKENS) {
                    tokens.set(response.mint, token);
                    logTokenCompletion(response.mint);
                } else {
                    tokenCache.set(response.mint, token);
                }
                // Always broadcast token update to all connected clients
                broadcastTokenUpdate(token);
                
                // Re-check user alerts when metadata is updated (twitter/website)
                // This ensures alerts that depend on metadata will trigger when it becomes available
                if (twitterUpdated || websiteUpdated) {
                    checkUserAlertsForToken(token).catch(error => {
                        console.error(`Error checking user alerts after metadata update (URI) for token ${response.mint}:`, error.message);
                    });
                }
            }
        };

        const updateTokenFromTokenData = async (tokenData) => {
            // Get token from storage or cache
            let token = STORE_TOKENS ? tokens.get(response.mint) : tokenCache.get(response.mint);
            
            // If token doesn't exist, create minimal token from API data
            if (!token) {
                // Create minimal token from API tokenData
                token = {
                    mint: response.mint || tokenData.mint,
                    value: tokenData.usd_market_cap_sol || 0,
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'UNKNOWN',
                    deployer: tokenData.creator || null,
                    devBuy: null,
                    uri: tokenData.metadata_uri || null,
                    created: Date.now(),
                    description: null,
                    image: null,
                    twitter: null,
                    website: null,
                    telegram: null,
                    banner_uri: tokenData.banner_uri || null,
                    marketCapSol: tokenData.usd_market_cap_sol || 0,
                    allTimeHigh: tokenData.usd_market_cap_sol || 0, // Initialize ATH
                    totalBuys: 0,
                    totalSells: 0,
                    buyVolume: 0,
                    sellVolume: 0,
                    uniqueBuyers: new Set(),
                    tradesPerMinute: []
                };
                // Store in cache for future updates
                tokenCache.set(response.mint, token);
            }

            let hasChanges = false;
            let twitterUpdated = false;
            let websiteUpdated = false;
            if (tokenData.image_uri && token.image !== tokenData.image_uri) {
                token.image = tokenData.image_uri;
                hasChanges = true;
            }
            if (tokenData.description !== undefined && token.description !== tokenData.description) {
                token.description = tokenData.description;
                hasChanges = true;
            }
            if (tokenData.twitter !== undefined && token.twitter !== tokenData.twitter) {
                token.twitter = tokenData.twitter;
                hasChanges = true;
                twitterUpdated = true;
                // Check for OG event when twitter is updated
                if (tokenData.twitter) {
                    checkOGEvent(token).catch(error => {
                        console.error(`Error checking OG event for token ${token.mint}:`, error.message);
                    });
                }
            }
            if (tokenData.website !== undefined && token.website !== tokenData.website) {
                token.website = tokenData.website;
                hasChanges = true;
                websiteUpdated = true;
            }
            if (tokenData.telegram !== undefined && token.telegram !== tokenData.telegram) {
                token.telegram = tokenData.telegram;
                hasChanges = true;
            }
            if (tokenData.banner_uri !== undefined && token.banner_uri !== tokenData.banner_uri) {
                token.banner_uri = tokenData.banner_uri;
                hasChanges = true;
            }

            if (hasChanges) {
                // Update both storage and cache
                if (STORE_TOKENS) {
                    tokens.set(response.mint, token);
                    logTokenCompletion(response.mint);
                } else {
                    tokenCache.set(response.mint, token);
                }
                // Always broadcast token update to all connected clients
                broadcastTokenUpdate(token);
                
                // Re-check user alerts when metadata is updated (twitter/website)
                // This ensures alerts that depend on metadata will trigger when it becomes available
                if (twitterUpdated || websiteUpdated) {
                    checkUserAlertsForToken(token).catch(error => {
                        console.error(`Error checking user alerts after metadata update (API) for token ${response.mint}:`, error.message);
                    });
                }
            }
        };

        const logTokenCompletion = (mint) => {
            const token = tokens.get(mint);
            if (!token) return;
            
            const hasAllData = token.description !== null && token.image !== null;
            const newStatus = hasAllData ? 'COMPLETE' : 'PARTIAL';
            
            // Only log if status changed
            if (token._status !== newStatus) {
                token._status = newStatus;
                tokens.set(mint, token);
                console.log(`Token [${newStatus}]: ${token.name} (${token.symbol}) - ${mint}`);
            }
        };

        // Add a small delay to allow the token to be indexed by the API
        setTimeout(async () => {
            try {
                const uriData = await getUri(response.mint);
                if (uriData) {
                    await updateTokenFromUriData(uriData);
                } else {
                    // Fallback to getToken if URI returns null
                    try {
                        const token = await getToken(response.mint);
                        if (token) {
                            await updateTokenFromTokenData(token);
                        }
                    } catch (error) {
                        // Silently handle errors, token remains partial
                    }
                }
            } catch (error) {
                // Fallback to getToken if URI fetch fails
                try {
                    const token = await getToken(response.mint);
                    if (token) {
                        await updateTokenFromTokenData(token);
                    }
                } catch (err) {
                    // Silently handle errors, token remains partial
                }
            }
        }, 1000); // Wait 1 second before fetching
        
        // Add a small delay to allow the token to be indexed by the API
        setTimeout(async () => {
            try {
                const token = await getToken(response.mint);
                if (token) {
                    await updateTokenFromTokenData(token);
                }
            } catch (error) {
                // Silently handle errors, token remains partial
            }
        }, 1500); // Wait 1.5 seconds before fetching
    }

    // Handle buy/sell trade messages
    if ((response.txType === 'buy' || response.txType === 'sell') && response.pool === 'pump') {
        // Get token from storage or cache (for alert checking even when not storing)
        let token = STORE_TOKENS ? tokens.get(response.mint) : tokenCache.get(response.mint);
        if (!token) return; // Token not in memory or cache, ignore
        
        const isBuy = response.txType === 'buy';
        const solAmount = response.solAmount || 0;
        
        // Update market cap (always update for alert checking)
        if (response.marketCapSol !== undefined) {
            token.marketCapSol = response.marketCapSol;
            token.value = response.marketCapSol; // Also update value field for consistency
            
            // Update All Time High if current marketcap exceeds it
            if (!token.allTimeHigh || response.marketCapSol > token.allTimeHigh) {
                token.allTimeHigh = response.marketCapSol;
            }
            
            // Save back to cache if not storing
            if (!STORE_TOKENS) {
                tokenCache.set(response.mint, token);
            }
            
            // Client-side alert checking (server-side checking kept for future Telegram bot)
            // checkAlertsForToken(token).catch(error => {
            //     console.error(`Error checking alerts for marketcap update ${response.mint}:`, error.message);
            // });
        }
        
        // Only process trades if storing tokens
        if (!STORE_TOKENS) return;
        
        // Update trade counts
        if (isBuy) {
            token.totalBuys++;
            token.buyVolume += solAmount;
            // Track unique buyers
            if (response.traderPublicKey) {
                token.uniqueBuyers.add(response.traderPublicKey);
            }
        } else {
            token.totalSells++;
            token.sellVolume += solAmount;
        }
        
        // Update per-minute trade data
        updateTradesPerMinute(token, isBuy, solAmount);
        
        // Update last transaction time
        lastTransactionTime.set(response.mint, Date.now());
        
        // Save updated token
        tokens.set(response.mint, token);
        
        // Emit trade event for demo
        io.emit('trade:event', {
            type: isBuy ? 'buy' : 'sell',
            mint: response.mint,
            tokenName: token.name,
            tokenSymbol: token.symbol,
            solAmount: solAmount,
            marketCapSol: response.marketCapSol || token.marketCapSol,
            totalBuys: token.totalBuys,
            totalSells: token.totalSells,
            timestamp: Date.now()
        });
        
        // Broadcast update to clients
        broadcastTokenUpdate(token);
    }

    // Handle migration events (token completion)
    if (response.txType === 'migrate' && response.pool === 'pump') {
        // Get token from storage or cache
        let token = STORE_TOKENS ? tokens.get(response.mint) : tokenCache.get(response.mint);
        if (!token) return; // Token not in memory or cache, ignore
        
        // Mark token as complete
        token.complete = true;
        token.migratedAt = Date.now();
        
        // Update both storage and cache
        if (STORE_TOKENS) {
            tokens.set(response.mint, token);
        } else {
            tokenCache.set(response.mint, token);
        }
        
        // Broadcast completion update to clients
        const tokenData = prepareTokenForBroadcast(token);
        tokenData.complete = true;
        tokenData.migratedAt = token.migratedAt;
        io.emit('token:complete', tokenData);
        
        // Get marketcap from token
        const marketCapSol = token.marketCapSol || token.value || 0;
        const marketCapUSD = token.marketCapUSD || (marketCapSol && solanaPriceUSD ? marketCapSol * solanaPriceUSD : 0);
        
        // Emit migration event for token events ticker
        io.emit('token:event', {
            type: 'migration',
            token: {
                mint: token.mint,
                name: token.name || 'Unknown',
                symbol: token.symbol || 'UNKNOWN',
                image: token.image || null,
                marketCapSol: marketCapSol,
                marketCapUSD: marketCapUSD
            }
        });
        
        // Also send as regular update so clients see the change
        broadcastTokenUpdate(token);
        
        // Set timeout to remove token after 5 minutes (300000 ms)
        const timeoutId = setTimeout(() => {
            console.log(`Removing migrated token after 5 minutes: ${token.name} (${token.symbol}) - ${response.mint}`);
            removeToken(response.mint);
            migrationTimeouts.delete(response.mint);
        }, 5 * 60 * 1000); // 5 minutes
        
        // Store timeout ID so we can clear it if needed
        migrationTimeouts.set(response.mint, timeoutId);
    }

    //console.log(JSON.parse(data));
    });
}

// Function to handle token migration via API check (fallback for missed migration events)
async function handleTokenMigrationCheck(mint, token) {
    try {
        // Emit operation start
        io.emit('backend:operation', {
            type: 'api-request',
            message: `Checking migration status: ${token.name}`,
            mint: mint.substring(0, 8),
            timestamp: Date.now()
        });
        
        const apiTokenData = await getToken(mint);
        if (!apiTokenData) {
            return false; // Token not found, skip
        }
        
        // Check if token is complete
        if (apiTokenData.complete === true) {
            // Token has migrated - handle it
            if (token.complete) {
                return false; // Already marked as complete, skip
            }
            
            console.log(`[Migration Check] Token ${token.name} (${token.symbol}) - ${mint} is complete (missed migration event)`);
            
            // Mark token as complete
            token.complete = true;
            token.migratedAt = Date.now();
            
            // Update both storage and cache
            if (STORE_TOKENS) {
                tokens.set(mint, token);
            } else {
                tokenCache.set(mint, token);
            }
            
            // Broadcast completion update to clients
            const tokenData = prepareTokenForBroadcast(token);
            tokenData.complete = true;
            tokenData.migratedAt = token.migratedAt;
            io.emit('token:complete', tokenData);
            
            // Also send as regular update so clients see the change
            broadcastTokenUpdate(token);
            
            // Emit operation result
            io.emit('backend:operation', {
                type: 'migration-found',
                message: `Token migrated: ${token.name}`,
                mint: mint.substring(0, 8),
                timestamp: Date.now()
            });
            
            // Set timeout to remove token after 5 minutes (300000 ms)
            const timeoutId = setTimeout(() => {
                console.log(`Removing migrated token after 5 minutes: ${token.name} (${token.symbol}) - ${mint}`);
                io.emit('backend:operation', {
                    type: 'cleanup',
                    message: `Removing completed token: ${token.name}`,
                    mint: mint.substring(0, 8),
                    timestamp: Date.now()
                });
                removeToken(mint);
                migrationTimeouts.delete(mint);
            }, 5 * 60 * 1000); // 5 minutes
            
            // Store timeout ID so we can clear it if needed
            migrationTimeouts.set(mint, timeoutId);
            
            // Clear last transaction time since token is complete
            lastTransactionTime.delete(mint);
            
            return true;
        } else {
            // Token is not complete, update marketcap if it has changed
            const newMarketCapSol = apiTokenData.usd_market_cap_sol || 0;
            if (newMarketCapSol !== token.marketCapSol && newMarketCapSol > 0) {
                console.log(`[Migration Check] Updating marketcap for ${token.name} (${token.symbol}): ${token.marketCapSol} -> ${newMarketCapSol} SOL`);
                
                token.marketCapSol = newMarketCapSol;
                token.value = newMarketCapSol;
                
                // Update All Time High if current marketcap exceeds it
                if (!token.allTimeHigh || newMarketCapSol > token.allTimeHigh) {
                    token.allTimeHigh = newMarketCapSol;
                }
                
                // Update both storage and cache
                if (STORE_TOKENS) {
                    tokens.set(mint, token);
                } else {
                    tokenCache.set(mint, token);
                }
                
                // Broadcast update to clients
                broadcastTokenUpdate(token);
                
                // Emit operation result
                io.emit('backend:operation', {
                    type: 'marketcap-update',
                    message: `Updated marketcap: ${token.name} → ${newMarketCapSol.toFixed(2)} SOL`,
                    mint: mint.substring(0, 8),
                    timestamp: Date.now()
                });
            }
            
            return false;
        }
    } catch (error) {
        console.error(`[Migration Check] Error checking token ${mint}:`, error.message);
        io.emit('backend:operation', {
            type: 'error',
            message: `API check failed: ${token.name}`,
            error: error.message,
            timestamp: Date.now()
        });
        return false;
    }
}

// Function to check for tokens that need migration verification
function checkHighMarketcapTokens() {
    if (!STORE_TOKENS) return;
    
    const now = Date.now();
    const thirtySecondsAgo = now - (30 * 1000); // 30 seconds in milliseconds
    const MIN_MARKETCAP_SOL = 400;
    
    let checkedCount = 0;
    let completedCount = 0;
    
    // Check all stored tokens
    for (const [mint, token] of tokens.entries()) {
        // Skip if already complete
        if (token.complete) continue;
        
        // Skip if marketcap is below 400 SOL
        const marketCapSol = token.marketCapSol || token.value || 0;
        if (marketCapSol < MIN_MARKETCAP_SOL) continue;
        
        // Check if token has had no transactions for 30 seconds
        const lastTxTime = lastTransactionTime.get(mint);
        if (!lastTxTime || lastTxTime < thirtySecondsAgo) {
            checkedCount++;
            // Token qualifies for migration check
            handleTokenMigrationCheck(mint, token).then(wasCompleted => {
                if (wasCompleted) completedCount++;
            }).catch(error => {
                console.error(`[Migration Check] Failed to check token ${mint}:`, error.message);
            });
        }
    }
    
    // Emit backend operation event for demo
    if (checkedCount > 0) {
        io.emit('backend:operation', {
            type: 'migration-check',
            message: `Checked ${checkedCount} high marketcap tokens for migration`,
            checkedCount,
            timestamp: Date.now()
        });
    }
}

// Start interval to check high marketcap tokens every 10 seconds
let migrationCheckInterval = null;
function startMigrationCheckInterval() {
    // Clear existing interval if any
    if (migrationCheckInterval) {
        clearInterval(migrationCheckInterval);
        migrationCheckInterval = null;
    }
    
    // Check every 10 seconds
    migrationCheckInterval = setInterval(() => {
        checkHighMarketcapTokens();
    }, 10 * 1000); // 10 seconds
}

// Function to start heartbeat check
function startHeartbeat() {
    // Clear existing interval if any
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    
    // Check every 5 seconds if we've received any message in the last 20 seconds
    heartbeatInterval = setInterval(() => {
        // Check if WebSocket is still open
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (ws) {
                console.log(`WebSocket is not open (state: ${ws.readyState}). Reconnecting...`);
            } else {
                console.log('WebSocket is null. Reconnecting...');
            }
            reconnectWebSocket();
            return;
        }
        
        const timeSinceLastMessage = Date.now() - lastMessageTime;
        
        if (timeSinceLastMessage >= 20000) { // 20 seconds
            console.log(`No messages received for ${Math.floor(timeSinceLastMessage / 1000)} seconds. WebSocket state: ${ws.readyState}. Restarting WebSocket...`);
            reconnectWebSocket();
        }
    }, 5000); // Check every 5 seconds
}

// Initialize WebSocket connection
ws = new WebSocket(WS_URL);
setupWebSocketHandlers();

// Start migration check interval
startMigrationCheckInterval();

/*

Token creation data:
{
  signature: '5uU3ZJT2B7xdsQ2vJ4aUUDAVUzNQeGYTtAtiszjZtAAAXANu7gpNLgAu3NzuSFK8yjzX6WPyoQNktQdS96meouoK',        
  mint: '7oy1c5MustEq3bR9rJLbzYuA5fdjc2i3juBNmYkgpump',
  traderPublicKey: 'DLSf8BxPTp7RTkU59kzhhECevUsKuUHG3TjzTAsmZCyB',
  txType: 'create',
  initialBuy: 28259.285923,
  solAmount: 0.000790122,
  bondingCurveKey: '41x4TgwsqGDvCXKnKM7RaJebxRagECsBjd9tSdYG4eVz',
  vTokensInBondingCurve: 1072971740.714077,
  vSolInBondingCurve: 30.000790121999977,
  marketCapSol: 27.960466230018373,
  name: 'Toilet Water',
  symbol: 'TW',
  uri: 'https://ipfs.io/ipfs/bafkreibktj4xi2f5mhfo23urfrus77ajqocgwpwznameixwv5cjbgyflya',
  pool: 'pump'
}

Token metadata:
{
  "mint": "DwCLoDKVBdCpjLqFBVZRuL92EMXbEXLiCaXdMW1dLAwp",
  "name": "thermoputer",
  "symbol": "thermopute",
  "description": "",
  "image_uri": "https://www.hobbyland.eu/img/prodotti/12305.webp",
  "metadata_uri": "http://93.205.10.67:4141/metadata/dEvT6epU",
  "twitter": "https://x.com/elonmusk/status/1985080954457817165",
  "telegram": "",
  "bonding_curve": "9xq74hemViNE8pUNQCmUcmXRFzcMxT7T5MWhdQZwQL9Z",
  "associated_bonding_curve": "7SSEDbZxYn98R7Qfk487fMXoLohV1ZbAPSjq4LhCBuaV",
  "creator": "bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa",
  "created_timestamp": 1762115163139,
  "raydium_pool": null,
  "complete": false,
  "virtual_sol_reserves": 35000000000,
  "virtual_token_reserves": 919714285714286,
  "hidden": null,
  "total_supply": 1000000000000000,
  "website": "",
  "show_name": true,
  "last_trade_timestamp": 1762115162000,
  "king_of_the_hill_timestamp": null,
  "market_cap": 38.055296675,
  "nsfw": false,
  "market_id": null,
  "inverted": null,
  "real_sol_reserves": 5000000000,
  "real_token_reserves": 639814285714286,
  "livestream_ban_expiry": 0,
  "last_reply": 1762115164000,
  "reply_count": 2,
  "is_banned": false,
  "is_currently_live": true,
  "initialized": true,
  "video_uri": null,
  "updated_at": 1762115164,
  "pump_swap_pool": null,
  "ath_market_cap": null,
  "ath_market_cap_timestamp": null,
  "banner_uri": null,
  "hide_banner": false,
  "livestream_downrank_score": 0,
  "program": "pump",
  "platform": null,
  "token_program": null,
  "mayhem_state": null,
  "usd_market_cap": 6993.041316998,
  "num_participants": 0
}

Token transaction data:
{
  signature: '215Pj8dPXuce5iz16pzvg5PB6t4Wak1jwh5F9CQQ2kac9PkFbkaTBGTcRiurRmbjxM3hHnCGRRCpgHEKacgRZiTy',        
  mint: 'HVvfHroD82TryDzoD4jzPUpxMA1WAEA73qemJmtqpump',
  traderPublicKey: '55mX9tbeNC6UDo6KLknzgBq7kNVpH4SWKxsAcw6c3emR',
  txType: 'buy',
  tokenAmount: 1549980.738003,
  solAmount: 0.049382716,
  newTokenBalance: 1549980.738003,
  bondingCurveKey: '6FDo4j2XWpFbGrhRsyWnYo7prqRkYTEv1gCVLU7JPuhW',
  vTokensInBondingCurve: 1004387519.261997,
  vSolInBondingCurve: 32.04938271599844,
  marketCapSol: 31.90937969793537,
  pool: 'pump'
}

Token migration data:
{
  signature: '4u6q31qU5z99K3e2p9q8p7o6n5m4l3k2j1h0g7f6e5d4c3b2a19876543210000000000000000000000000000000000000000000000000000000000000000',
  mint: 'HVvfHroD82TryDzoD4jzPUpxMA1WAEA73qemJmtqpump',
  traderPublicKey: '55mX9tbeNC6UDo6KLknzgBq7kNVpH4SWKxsAcw6c3emR',
  txType: 'migrate',
  newTokenBalance: 1549980.738003,
  bondingCurveKey: '6FDo4j2XWpFbGrhRsyWnYo7prqRkYTEv1gCVLU7JPuhW',
  vTokensInBondingCurve: 1004387519.261997,
}

*/

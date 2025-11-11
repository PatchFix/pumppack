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
const io = new Server(server);

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

// Helper function to read clients.json
function readClients() {
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

// Helper function to write clients.json
function writeClients(clients) {
    const clientsPath = join(__dirname, 'clients.json');
    try {
        fs.writeFileSync(clientsPath, JSON.stringify(clients, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error writing clients.json:', error.message);
        return false;
    }
}

// Helper function to hash password
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// API endpoint to check username availability
app.post('/api/users/check-username', (req, res) => {
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
    
    const clients = readClients();
    const isAvailable = !clients[username.toLowerCase()];
    
    res.json({ available: isAvailable });
});

// API endpoint to create user profile
app.post('/api/users/create', (req, res) => {
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
    
    const clients = readClients();
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
    
    if (writeClients(clients)) {
        res.json({ success: true, message: 'Profile created successfully' });
    } else {
        res.status(500).json({ error: 'Failed to create profile' });
    }
});

// API endpoint to authenticate user
app.post('/api/users/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const clients = readClients();
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
});

// API endpoint to save alerts to user profile
app.post('/api/users/save-alerts', (req, res) => {
    const { username, password, alerts } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (!Array.isArray(alerts)) {
        return res.status(400).json({ error: 'Alerts must be an array' });
    }
    
    const clients = readClients();
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
    
    if (writeClients(clients)) {
        res.json({ success: true, message: 'Alerts saved successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save alerts' });
    }
});

// API endpoint to get user alerts
app.post('/api/users/get-alerts', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const clients = readClients();
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
});

// API endpoint to receive Telegram webhook
app.post('/api/telegram/webhook', (req, res) => {
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
                const clients = readClients();
                const user = clients[linkedUsername];
                
                if (user) {
                    // Link Telegram to user profile
                    user.telegramLinked = true;
                    user.telegramChatId = chatId;
                    user.updatedAt = Date.now();
                    
                    if (writeClients(clients)) {
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
app.post('/api/users/check-telegram', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const clients = readClients();
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

// API endpoint to proxy developer tokens (avoid CORS issues)
app.get('/api/developer-tokens/:address', async (req, res) => {
    try {
        const { address } = req.params;
        console.log(`[Server] Fetching developer tokens for address: ${address}`);
        const response = await axios.get(`https://frontend-api-v3.pump.fun/coins/user-created-coins/${address}?offset=0&limit=100&includeNsfw=true`, {
            headers: {
                'Accept': 'application/json',
            },
            timeout: 10000
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching developer tokens:', error.message);
        res.status(500).json({ error: 'Failed to fetch developer tokens' });
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
                    
                    // Client-side alert checking (server-side checking kept for future Telegram bot)
                    // if (twitterUpdated || websiteUpdated) {
                    //     checkAlertsForToken(token).catch(error => {
                    //         console.error(`Error checking alerts after metadata refresh for token ${mint}:`, error.message);
                    //     });
                    // }
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
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Fetch Solana price at server start
    await updateSolanaPrice();
    
    // Update Solana price every minute
    setInterval(updateSolanaPrice, 60000); // 60000ms = 1 minute
    
    // Fetch current metas at startup
    await updateCurrentMetas();
    
    // Update metas every 5 minutes
    setInterval(updateCurrentMetas, 300000); // 300000ms = 5 minutes
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
        const response = await axios.get(`https://frontend-api-v3.pump.fun/coins/${mint}`);
        
        // Check if response data is empty
        if (!response.data || Object.keys(response.data).length === 0) {
            return null;
        }
        
        return response.data;
    } catch (error) {
        console.error(`Error fetching token data for ${mint}:`, error.message);
        throw error;
    }
}

/**
 * Fetch tokens created by a deployer address
 * @param {string} address - The deployer wallet address
 * @returns {Promise<Array|null>} Array of tokens created by the deployer, or null if not found
 */
async function getCreated(address) {
    try {
        const response = await axios.get(`https://frontend-api-v3.pump.fun/coins/user-created-coins/${address}?offset=0&limit=100&includeNsfw=true`);
        
        // Check if response data is empty
        if (!response.data) {
            return null;
        }
        
        // Handle different response structures
        let tokens = null;
        if (Array.isArray(response.data)) {
            // Response is directly an array
            tokens = response.data;
        } else if (response.data.data && Array.isArray(response.data.data)) {
            // Response has data property with array
            tokens = response.data.data;
        } else if (response.data.coins && Array.isArray(response.data.coins)) {
            // Response has coins property with array
            tokens = response.data.coins;
        } else if (response.data.items && Array.isArray(response.data.items)) {
            // Response has items property with array
            tokens = response.data.items;
        }
        
        if (!tokens || tokens.length === 0) {
            return null;
        }
        
        return tokens;
    } catch (error) {
        console.error(`Error fetching created tokens for ${address}:`, error.message);
        throw error;
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
        
        case 'deployer-bonded':
            // Check if the deployer has bonded percentage of their tokens
            if (!token.deployer) {
                return false;
            }
            try {
                const created = await getCreated(token.deployer);
                if (!created || !Array.isArray(created) || created.length === 0) {
                    return false;
                }
                
                // Filter out the current token (by mint) and calculate bonded percentage
                const otherTokens = created.filter(t => t.mint !== token.mint);
                if (otherTokens.length === 0) {
                    return false; // No other tokens to check
                }
                
                const bondedTokens = otherTokens.filter(t => t.complete === true);
                const bondedPercentage = (bondedTokens.length / otherTokens.length) * 100;
                
                return bondedPercentage >= alert.percentage;
            } catch (error) {
                console.error(`Error checking deployer-bonded alert for ${alert.id}:`, error.message);
                return false;
            }
        
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
        const clients = readClients();
        const triggeredUsers = new Set(); // Track users we've already notified for this token
        
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
                        // Create unique key for this user-token-alert combination
                        const alertKey = `${username}-${token.mint}-${alert.id}`;
                        
                        // Only send notification if we haven't already sent it
                        if (!triggeredUserAlerts.has(alertKey)) {
                            triggeredUserAlerts.add(alertKey);
                            
                            // Only send one notification per user per token (even if multiple alerts match)
                            if (!triggeredUsers.has(username)) {
                                triggeredUsers.add(username);
                                
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
                                
                                console.log(`📱 Telegram alert sent to ${username} for token ${token.name} (${token.symbol})`);
                            }
                        }
                        break; // Move to next user after finding a match
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
        case 'deployer-bonded':
            return `Developer has bonded ${alert.percentage || 'N/A'}% of tokens`;
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

        // Fetch created tokens to log developer stats (always fetch for logging)
        getCreated(response.traderPublicKey)
        .then(created => {
            if (created && Array.isArray(created)) {
                const totalCreated = created.length;
                const bondedTokens = created.filter(token => token.complete === true).length;
                const bondedPercentage = totalCreated > 0 ? (bondedTokens / totalCreated) * 100 : 0;
                
                // Find highest value token by usd_market_cap
                let highestValueToken = null;
                let highestMarketCap = 0;
                
                created.forEach(token => {
                    const marketCap = token.usd_market_cap || 0;
                    if (marketCap > highestMarketCap) {
                        highestMarketCap = marketCap;
                        highestValueToken = token;
                    }
                });
                
                // Developer stats calculated (console logging removed)
                console.log('Developer stats calculated');
            } else {
                console.log(`No created tokens found for ${response.traderPublicKey}`);
            }
        })
        .catch(error => {
            console.error(`Error fetching created tokens for ${response.traderPublicKey}:`, error.message);
        });
        
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
        checkUserAlertsForToken(tokenData).catch(error => {
            console.error(`Error checking user alerts for token ${response.mint}:`, error.message);
        });

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
                
                // Client-side alert checking (server-side checking kept for future Telegram bot)
                // if (twitterUpdated || websiteUpdated) {
                //     checkAlertsForToken(token).catch(error => {
                //         console.error(`Error checking alerts after metadata update for token ${response.mint}:`, error.message);
                //     });
                // }
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
                
                // Client-side alert checking (server-side checking kept for future Telegram bot)
                // if (twitterUpdated || websiteUpdated) {
                //     checkAlertsForToken(token).catch(error => {
                //         console.error(`Error checking alerts after metadata update for token ${response.mint}:`, error.message);
                //     });
                // }
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

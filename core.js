import WebSocket from 'ws';
import axios from 'axios';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ws = new WebSocket('wss://pumpportal.fun/api/data');

// In-memory token storage
const tokens = new Map();

// Minimal token cache for metadata updates (always maintained, even when STORE_TOKENS is false)
// This ensures metadata updates can work even if client missed creation event
const tokenCache = new Map();

// Configuration: Store tokens in memory and subscribe to trades
// If false, only broadcast to connected clients without storing
const STORE_TOKENS = true;

// Maximum number of tokens to keep in memory
const MAX_TOKENS = 100;

// Solana price in USD (updated every minute)
let solanaPriceUSD = 0;

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
                }
                if (tokenData.website !== undefined && token.website !== tokenData.website) {
                    token.website = tokenData.website;
                    hasChanges = true;
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
                }
            }
        } catch (error) {
            // Silently handle errors
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
function updateTradesPerMinute(token, isBuy) {
    const currentMinute = getCurrentMinute();
    const fifteenMinutesAgo = currentMinute - (15 * 60 * 1000);
    
    // Clean up old data (older than 15 minutes)
    token.tradesPerMinute = token.tradesPerMinute.filter(t => t.minute >= fifteenMinutesAgo);
    
    // Find or create entry for current minute
    let minuteEntry = token.tradesPerMinute.find(t => t.minute === currentMinute);
    if (!minuteEntry) {
        minuteEntry = { minute: currentMinute, buys: 0, sells: 0 };
        token.tradesPerMinute.push(minuteEntry);
    }
    
    // Update counts
    if (isBuy) {
        minuteEntry.buys++;
    } else {
        minuteEntry.sells++;
    }
}

// Helper function to remove oldest token(s) when limit is reached
function removeOldestTokens() {
    if (tokens.size <= MAX_TOKENS) {
        return; // No need to remove anything
    }
    
    // Convert to array and sort by creation timestamp (oldest first)
    const tokenArray = Array.from(tokens.entries()).map(([mint, token]) => ({
        mint,
        created: token.created || 0
    }));
    
    tokenArray.sort((a, b) => a.created - b.created);
    
    // Remove oldest tokens until we're under the limit
    const tokensToRemove = tokens.size - MAX_TOKENS;
    for (let i = 0; i < tokensToRemove; i++) {
        removeToken(tokenArray[i].mint);
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
server.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Fetch Solana price at server start
    await updateSolanaPrice();
    
    // Update Solana price every minute
    setInterval(updateSolanaPrice, 60000); // 60000ms = 1 minute
});

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

ws.on('open', function open() {

    // Subscribe to new token events
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));

    // Subscribe to migration events
    ws.send(JSON.stringify({ method: "subscribeMigration" }));

});

ws.on('message', function message(data) {

    let response = JSON.parse(data)

    // Subscribing to trades on tokens

    if (response.txType === 'create' && response.pool === 'pump') {
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
            
            // Remove oldest tokens if we've exceeded the limit
            removeOldestTokens();
        } else {
            // Just log when not storing
            console.log(`Token [PARTIAL]: ${response.name} (${response.symbol}) - ${response.mint}`);
        }

        // Always broadcast new token to all connected clients
        broadcastNewToken(tokenData);

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
            }
            if (uriData.website !== undefined && token.website !== uriData.website) {
                token.website = uriData.website;
                hasChanges = true;
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
            }
            if (tokenData.website !== undefined && token.website !== tokenData.website) {
                token.website = tokenData.website;
                hasChanges = true;
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
        // Only process trades if storing tokens
        if (!STORE_TOKENS) return;
        
        const token = tokens.get(response.mint);
        if (!token) return; // Token not in memory, ignore
        
        const isBuy = response.txType === 'buy';
        const solAmount = response.solAmount || 0;
        
        // Update market cap
        if (response.marketCapSol !== undefined) {
            token.marketCapSol = response.marketCapSol;
            token.value = response.marketCapSol; // Also update value field for consistency
        }
        
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
        updateTradesPerMinute(token, isBuy);
        
        // Save updated token
        tokens.set(response.mint, token);
        
        // Broadcast update to clients
        broadcastTokenUpdate(token);
    }

    //console.log(JSON.parse(data));
});

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

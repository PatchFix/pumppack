#!/usr/bin/env node

/**
 * Helper script to set Telegram webhook
 * 
 * Usage:
 *   node set-telegram-webhook.js https://yourdomain.com/api/telegram/webhook
 * 
 * Or use the API endpoint:
 *   curl -X POST http://localhost:3000/api/telegram/set-webhook \
 *     -H "Content-Type: application/json" \
 *     -d '{"webhookUrl": "https://yourdomain.com/api/telegram/webhook"}'
 */

import axios from 'axios';

const TELEGRAM_BOT_API_KEY = process.env.TELEGRAM_BOT_API_KEY || '8586873785:AAF55unRbhX99xCOfooTFs0Z6Pycu-FOY-A';
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_API_KEY}`;

const webhookUrl = process.argv[2];

if (!webhookUrl) {
    console.error('Usage: node set-telegram-webhook.js <webhook_url>');
    console.error('Example: node set-telegram-webhook.js https://tvc-bd86a009e58f.herokuapp.com/api/telegram/webhook');
    process.exit(1);
}

if (!webhookUrl.startsWith('http://') && !webhookUrl.startsWith('https://')) {
    console.error('Error: webhookUrl must start with http:// or https://');
    process.exit(1);
}

async function setWebhook() {
    try {
        console.log(`Setting webhook to: ${webhookUrl}`);
        
        const response = await axios.post(`${TELEGRAM_API_URL}/setWebhook`, {
            url: webhookUrl
        });
        
        if (response.data.ok) {
            console.log('✅ Webhook set successfully!');
            console.log(`Result: ${response.data.result}`);
            
            // Get webhook info to confirm
            const infoResponse = await axios.get(`${TELEGRAM_API_URL}/getWebhookInfo`);
            console.log('\nWebhook Info:');
            console.log(JSON.stringify(infoResponse.data.result, null, 2));
        } else {
            console.error('❌ Failed to set webhook');
            console.error(`Description: ${response.data.description}`);
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Error setting webhook:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
        process.exit(1);
    }
}

setWebhook();


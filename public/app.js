// Canvas Animations
class CanvasAnimations {
    constructor() {
        this.backgroundCanvas = document.getElementById('backgroundCanvas');
        this.statusCanvas = document.getElementById('statusCanvas');
        this.emptyCanvas = document.getElementById('emptyCanvas');
        
        if (!this.backgroundCanvas || !this.statusCanvas) {
            console.error('Required canvas elements not found');
            return;
        }
        
        this.bgCtx = this.backgroundCanvas.getContext('2d');
        this.statusCtx = this.statusCanvas.getContext('2d');
        
        if (this.emptyCanvas) {
            this.emptyCtx = this.emptyCanvas.getContext('2d');
            this.setupEmptyCanvas();
        }
        
        this.setupBackground();
    }

    setupBackground() {
        const resize = () => {
            this.backgroundCanvas.width = window.innerWidth;
            this.backgroundCanvas.height = window.innerHeight;
            this.animateBackground();
        };
        
        resize();
        window.addEventListener('resize', resize);
    }

    animateBackground() {
        const ctx = this.bgCtx;
        const width = this.backgroundCanvas.width;
        const height = this.backgroundCanvas.height;
        
        // Clear canvas
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, width, height);
        
        // Create animated particles
        const particleCount = Math.min(50, Math.floor((width * height) / 20000));
        const time = Date.now() * 0.001;
        
        for (let i = 0; i < particleCount; i++) {
            const x = (Math.sin(time * 0.5 + i) * 0.5 + 0.5) * width;
            const y = (Math.cos(time * 0.3 + i * 0.7) * 0.5 + 0.5) * height;
            const size = 1 + Math.sin(time + i) * 0.5;
            const opacity = 0.1 + Math.sin(time * 2 + i) * 0.05;
            
            ctx.fillStyle = `rgba(96, 165, 250, ${opacity})`;
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fill();
        }
        
        requestAnimationFrame(() => this.animateBackground());
    }

    updateStatus(isConnected) {
        const ctx = this.statusCtx;
        ctx.clearRect(0, 0, 12, 12);
        
        const gradient = ctx.createRadialGradient(6, 6, 0, 6, 6, 6);
        if (isConnected) {
            gradient.addColorStop(0, '#4ade80');
            gradient.addColorStop(1, '#16a34a');
        } else {
            gradient.addColorStop(0, '#f87171');
            gradient.addColorStop(1, '#dc2626');
        }
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(6, 6, 5, 0, Math.PI * 2);
        ctx.fill();
        
        // Pulse animation
        const pulse = (1 + Math.sin(Date.now() * 0.005)) * 0.5;
        ctx.globalAlpha = 0.3 + pulse * 0.2;
        ctx.beginPath();
        ctx.arc(6, 6, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    setupEmptyCanvas() {
        if (!this.emptyCtx) return;
        
        const ctx = this.emptyCtx;
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        
        // Draw a simple bell/alert icon
        const centerX = 40;
        const centerY = 40;
        
        // Bell shape
        ctx.beginPath();
        ctx.moveTo(centerX - 15, centerY - 10);
        ctx.lineTo(centerX - 10, centerY + 15);
        ctx.lineTo(centerX + 10, centerY + 15);
        ctx.lineTo(centerX + 15, centerY - 10);
        ctx.arc(centerX, centerY - 10, 15, Math.PI, 0, false);
        ctx.stroke();
        
        // Clapper
        ctx.beginPath();
        ctx.arc(centerX, centerY + 5, 3, 0, Math.PI * 2);
        ctx.stroke();
    }
}

// Main App
class AlertApp {
    constructor() {
        this.canvasAnimations = new CanvasAnimations();
        this.socket = io();
        this.alerts = [];
        this.matchedTokens = new Map(); // Store matched tokens by mint address
        this.triggeredAlerts = new Set(); // Track which alerts have been triggered for which tokens (mint-alertId)
        this.dexTokens = new Map(); // Store dex alert tokens by slot (0, 1, 2)
        this.dexTokenUpdateInterval = null; // Interval for updating dex token marketcaps
        this.dexScreenerCheckInterval = null; // Interval for checking dexscreener status
        this.dexScreenerStatuses = new Map(); // Track status alerts already triggered (slot -> Set of statuses)
        this.solanaPriceUSD = 0;
        this.currentMetas = []; // Store current metas for ticker
        this.developerTokensCache = new Map(); // Cache developer tokens to avoid spam requests
        this.pendingDeleteId = null;
        this.pendingDexSlot = null;
        this.loadedImages = new Set(); // Track which image URLs have been successfully loaded
        this.settings = {
            tokenClickOption: 'pumpfun', // Default: Pump.Fun
            alertVolume: 50, // Default: 50%
            theme: 'pump' // Default: pump theme
        };
        this.audioContext = null; // Will be initialized
        this.initElements();
        // Load settings from localStorage before initializing socket
        this.loadSettingsFromStorage();
        // Load user session from localStorage if available
        this.loadUserSessionFromStorage();
        // Load dex tokens from localStorage (always local, not saved to profile)
        this.loadDexTokensFromStorage();
        this.initAlertSound();
        this.initSocket();
        this.initEventListeners();
        // Initialize dex tokens display
        this.renderDexTokens();
    }

    initAlertSound() {
        // Create a simple alert sound using Web Audio API
        // Using a short beep sound
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioContext = audioContext;
        } catch (error) {
            console.warn('Web Audio API not supported, alert sounds disabled');
            this.audioContext = null;
        }
    }

    async playAlertSound(isNegative = false) {
        if (!this.audioContext || this.settings.alertVolume === 0) {
            return;
        }

        try {
            // Resume audio context if suspended (required by some browsers)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            const volume = this.settings.alertVolume / 100;
            
            if (isNegative) {
                // Negative alert sound (lower, descending tones)
                gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(volume * 0.3, this.audioContext.currentTime + 0.01);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
                
                oscillator.frequency.setValueAtTime(400, this.audioContext.currentTime);
                oscillator.frequency.setValueAtTime(300, this.audioContext.currentTime + 0.15);
                oscillator.type = 'sawtooth';
                
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.3);
            } else {
                // Positive alert sound (pleasant two-tone)
                gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(volume * 0.3, this.audioContext.currentTime + 0.01);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
                
                oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime);
                oscillator.frequency.setValueAtTime(1000, this.audioContext.currentTime + 0.1);
                oscillator.type = 'sine';
                
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.2);
            }
        } catch (error) {
            console.warn('Error playing alert sound:', error);
        }
    }

    async playDexAlertSound(isNegative = false) {
        if (!this.audioContext || this.settings.alertVolume === 0) {
            return;
        }

        try {
            // Resume audio context if suspended (required by some browsers)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            const volume = this.settings.alertVolume / 100;
            
            if (isNegative) {
                // Negative dex alert sound (lower, descending tones with more character)
                gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(volume * 0.35, this.audioContext.currentTime + 0.01);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.35);
                
                oscillator.frequency.setValueAtTime(350, this.audioContext.currentTime);
                oscillator.frequency.setValueAtTime(250, this.audioContext.currentTime + 0.2);
                oscillator.type = 'square';
                
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.35);
            } else {
                // Positive dex alert sound (distinctive three-tone ascending pattern)
                gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(volume * 0.25, this.audioContext.currentTime + 0.01);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
                
                // Three-tone pattern: 600Hz -> 800Hz -> 1000Hz
                oscillator.frequency.setValueAtTime(600, this.audioContext.currentTime);
                oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime + 0.1);
                oscillator.frequency.setValueAtTime(1000, this.audioContext.currentTime + 0.2);
                oscillator.type = 'sine';
                
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.3);
            }
        } catch (error) {
            console.warn('Error playing dex alert sound:', error);
        }
    }

    initElements() {
        this.statusEl = document.getElementById('status');
        this.statusText = this.statusEl.querySelector('.status-text');
        this.alertForm = document.getElementById('alertForm');
        this.alertType = document.getElementById('alertType');
        this.formFieldsSection = document.getElementById('formFieldsSection');
        this.createAlertBtn = document.getElementById('createAlertBtn');
        this.createAlertModal = document.getElementById('createAlertModal');
        this.closeModalBtn = document.getElementById('closeModalBtn');
        this.cancelBtn = document.getElementById('cancelBtn');
        this.editAlertsBtn = document.getElementById('editAlertsBtn');
        this.editAlertsModal = document.getElementById('editAlertsModal');
        this.closeEditModalBtn = document.getElementById('closeEditModalBtn');
        this.settingsBtn = document.getElementById('settingsBtn');
        this.settingsModal = document.getElementById('settingsModal');
        this.closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
        this.saveSettingsBtn = document.getElementById('saveSettingsBtn');
        this.dmAlertsBtn = document.getElementById('dmAlertsBtn');
        this.dmAlertsModal = document.getElementById('dmAlertsModal');
        this.closeDmAlertsBtn = document.getElementById('closeDmAlertsBtn');
        
        // DM Alerts slideshow elements
        this.usernameInput = document.getElementById('usernameInput');
        this.passwordInput = document.getElementById('passwordInput');
        this.checkUsernameBtn = document.getElementById('checkUsernameBtn');
        this.createProfileOptionBtn = document.getElementById('createProfileOptionBtn');
        this.loginOptionBtn = document.getElementById('loginOptionBtn');
        this.createProfileBtn = document.getElementById('createProfileBtn');
        this.backToUsernameBtn = document.getElementById('backToUsernameBtn');
        this.backToOptionsBtn = document.getElementById('backToOptionsBtn');
        this.backToOptionsFromLoginBtn = document.getElementById('backToOptionsFromLoginBtn');
        this.loginBtn = document.getElementById('loginBtn');
        this.loginUsername = document.getElementById('loginUsername');
        this.loginPassword = document.getElementById('loginPassword');
        this.linkTelegramBtn = document.getElementById('linkTelegramBtn');
        this.logoutBtn = document.getElementById('logoutBtn');
        
        // Current user session
        this.currentUser = null;
        this.helpBtn = document.getElementById('helpBtn');
        this.helpModal = document.getElementById('helpModal');
        this.closeHelpBtn = document.getElementById('closeHelpBtn');
        this.closeHelpBtn2 = document.getElementById('closeHelpBtn2');
        this.settingsOptionButtons = document.querySelectorAll('.settings-option-btn:not(.theme-btn)');
        this.themeButtons = document.querySelectorAll('.theme-btn');
        this.alertVolumeSlider = document.getElementById('alertVolume');
        this.volumeValue = document.getElementById('volumeValue');
        this.tokenAlertsList = document.getElementById('tokenAlertsList');
        this.developerAlertsList = document.getElementById('developerAlertsList');
        this.socialAlertsList = document.getElementById('socialAlertsList');
        this.alertTabs = document.querySelectorAll('.alert-tab');
        this.valueGroup = document.getElementById('valueGroup');
        this.thresholdGroup = document.getElementById('thresholdGroup');
        this.percentageGroup = document.getElementById('percentageGroup');
        this.nameGroup = document.getElementById('nameGroup');
        this.deleteConfirmModal = document.getElementById('deleteConfirmModal');
        this.confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
        this.cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
        this.closeDeleteConfirmBtn = document.getElementById('closeDeleteConfirmBtn');
        this.clearAllTokensBtn = document.getElementById('clearAllTokensBtn');
        this.clearAllTokensConfirmModal = document.getElementById('clearAllTokensConfirmModal');
        this.confirmClearAllTokensBtn = document.getElementById('confirmClearAllTokensBtn');
        this.cancelClearAllTokensBtn = document.getElementById('cancelClearAllTokensBtn');
        this.closeClearAllTokensConfirmBtn = document.getElementById('closeClearAllTokensConfirmBtn');
        this.dexTokenInputModal = document.getElementById('dexTokenInputModal');
        this.dexTokenMintInput = document.getElementById('dexTokenMintInput');
        this.confirmDexTokenInputBtn = document.getElementById('confirmDexTokenInputBtn');
        this.cancelDexTokenInputBtn = document.getElementById('cancelDexTokenInputBtn');
        this.closeDexTokenInputBtn = document.getElementById('closeDexTokenInputBtn');
        this.metasTickerContainer = document.getElementById('metasTickerContainer');
        this.metasTicker = document.getElementById('metasTicker');
        this.alertsContainer = document.getElementById('alertsContainer');
        this.matchedTokensContainer = document.getElementById('matchedTokensContainer');
    }

    initSocket() {
        this.socket.on('connect', () => {
            this.statusText.textContent = 'Connected';
            this.statusEl.className = 'status-indicator connected';
            this.canvasAnimations.updateStatus(true);
            // Load alerts from server if logged in, otherwise start with empty alerts
            if (this.currentUser) {
                this.loadAlertsFromServer();
            } else {
                this.alerts = [];
                this.renderAlerts();
            }
        });

        this.socket.on('solana:price', (data) => {
            if (data.price && data.price > 0) {
                this.solanaPriceUSD = data.price;
                this.renderMatchedTokens(); // Re-render to update USD values
            }
        });

        // Listen for current metas updates
        this.socket.on('metas:current', (data) => {
            if (data.metas && Array.isArray(data.metas) && data.metas.length > 0) {
                this.currentMetas = data.metas;
                this.renderMetasTicker();
            }
        });

        this.socket.on('disconnect', () => {
            this.statusText.textContent = 'Disconnected';
            this.statusEl.className = 'status-indicator disconnected';
            this.canvasAnimations.updateStatus(false);
            // Continue updating tokens even when disconnected
        });

        // Listen for new tokens and check alerts
        this.socket.on('token:new', (tokenData) => {
            this.checkAlertsForToken(tokenData, true); // true = isNewToken
        });

        // Listen for token updates and check alerts
        this.socket.on('token:update', (tokenData) => {
            // Update matched tokens in real-time if they exist
            if (this.matchedTokens.has(tokenData.mint)) {
                this.updateMatchedToken(tokenData);
            }
            // Also check for new alert matches
            this.checkAlertsForToken(tokenData, false); // false = not a new token (trade update)
        });
        
        // Listen for token completion (migration)
        this.socket.on('token:complete', (tokenData) => {
            // Update matched token if it exists
            if (this.matchedTokens.has(tokenData.mint)) {
                this.updateMatchedToken(tokenData);
            }
        });
        
        // Listen for token removal (token no longer tracked)
        this.socket.on('token:remove', (data) => {
            if (data.mint && this.matchedTokens.has(data.mint)) {
                // Optionally remove the token from matched tokens when it's removed from the server
                // For now, we'll keep it in the matched tokens list even after removal
                // Uncomment the line below if you want to auto-remove matched tokens when they're removed from the server
                // this.deleteMatchedToken(data.mint);
            }
        });

        // Listen for dex token data from server
        this.socket.on('dex:token', (data) => {
            if (data.slot !== undefined && data.token) {
                this.dexTokens.set(data.slot, data.token);
                // Initialize status tracking for this slot
                if (!this.dexScreenerStatuses.has(data.slot)) {
                    this.dexScreenerStatuses.set(data.slot, new Set());
                }
                this.saveDexTokensToStorage(); // Save to localStorage
                this.renderDexTokens();
                // Start updates if not already running
                if (!this.dexTokenUpdateInterval) {
                    this.startDexTokenUpdates();
                }
                // Start DexScreener checks if not already running
                if (!this.dexScreenerCheckInterval) {
                    this.startDexScreenerChecks();
                }
            }
        });

        // Listen for dex token error
        this.socket.on('dex:token:error', (data) => {
            if (data.slot !== undefined && data.error) {
                this.showToast(`Error fetching token: ${data.error}`, 'error');
            }
        });

        // Listen for dex token updates (for marketcap updates)
        this.socket.on('dex:token:update', (data) => {
            if (data.slot !== undefined && data.token) {
                const existingToken = this.dexTokens.get(data.slot);
                if (existingToken) {
                    // Update only the marketcap and other updatable fields
                    existingToken.marketCapUSD = data.token.marketCapUSD;
                    this.dexTokens.set(data.slot, existingToken);
                    // Update just the marketcap value in the DOM without re-rendering
                    this.updateDexTokenMarketcap(data.slot, data.token.marketCapUSD);
                }
            }
        });
    }

    async loadAlertsFromServer() {
        if (!this.currentUser) return;
        
        try {
            const response = await fetch('/api/users/get-alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.currentUser.username,
                    password: this.currentUser.password
                })
            });
            
            const data = await response.json();
            if (response.ok && data.success) {
                this.alerts = data.alerts || [];
                this.renderAlerts();
            }
        } catch (error) {
            console.error('Error loading alerts from server:', error);
            this.alerts = [];
            this.renderAlerts();
        }
    }

    loadUserSessionFromStorage() {
        try {
            const stored = localStorage.getItem('userSession');
            if (stored) {
                const session = JSON.parse(stored);
                if (session.username && session.password) {
                    // Restore user session
                    this.currentUser = {
                        username: session.username,
                        password: session.password
                    };
                    // Verify session is still valid (async, will update UI when complete)
                    // Alerts will be loaded when socket connects if session is valid
                    this.verifyAndRestoreSession().catch(error => {
                        console.error('Error verifying session:', error);
                    });
                }
            }
        } catch (error) {
            console.error('Error loading user session from localStorage:', error);
            // Clear invalid session
            localStorage.removeItem('userSession');
        }
    }

    saveUserSessionToStorage() {
        if (this.currentUser) {
            try {
                localStorage.setItem('userSession', JSON.stringify({
                    username: this.currentUser.username,
                    password: this.currentUser.password
                }));
            } catch (error) {
                console.error('Error saving user session to localStorage:', error);
            }
        }
    }

    clearUserSessionFromStorage() {
        try {
            localStorage.removeItem('userSession');
        } catch (error) {
            console.error('Error clearing user session from localStorage:', error);
        }
    }

    async verifyAndRestoreSession() {
        if (!this.currentUser) return;
        
        try {
            // Verify session is still valid by checking if user can get alerts
            const response = await fetch('/api/users/get-alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.currentUser.username,
                    password: this.currentUser.password
                })
            });
            
            const data = await response.json();
            if (response.ok && data.success) {
                // Session is valid
                // Update modal UI if it exists
                const loggedInUsername = document.getElementById('loggedInUsername');
                if (loggedInUsername) loggedInUsername.textContent = this.currentUser.username;
                
                // Update login button text
                this.updateLoginButtonText();
                
                // Check Telegram status
                this.checkTelegramStatus();
                
                // If socket is already connected, load alerts now
                // Otherwise, alerts will be loaded when socket connects
                if (this.socket && this.socket.connected) {
                    this.loadAlertsFromServer();
                }
            } else {
                // Session is invalid, clear it
                this.currentUser = null;
                this.clearUserSessionFromStorage();
                // Update login button text
                this.updateLoginButtonText();
                // Clear alerts if session is invalid
                this.alerts = [];
                this.renderAlerts();
            }
        } catch (error) {
            console.error('Error verifying user session:', error);
            // On error, keep the session and let socket connection handle alert loading
        }
    }

    async autoSaveAlerts() {
        // Only auto-save if user is logged in
        if (!this.currentUser) return;
        
        try {
            const response = await fetch('/api/users/save-alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.currentUser.username,
                    password: this.currentUser.password,
                    alerts: this.alerts
                })
            });
            
            const data = await response.json();
            if (!response.ok || !data.success) {
                console.error('Error auto-saving alerts:', data.error);
            }
        } catch (error) {
            console.error('Error auto-saving alerts:', error);
        }
    }

    loadDexTokensFromStorage() {
        try {
            const stored = localStorage.getItem('dexTokens');
            if (stored) {
                const dexTokensData = JSON.parse(stored);
                // Convert array back to Map
                this.dexTokens = new Map();
                if (Array.isArray(dexTokensData)) {
                    dexTokensData.forEach(([slot, token]) => {
                        this.dexTokens.set(slot, token);
                    });
                } else if (typeof dexTokensData === 'object') {
                    // Handle object format (backward compatibility)
                    Object.entries(dexTokensData).forEach(([slot, token]) => {
                        this.dexTokens.set(parseInt(slot), token);
                    });
                }
            }
        } catch (error) {
            console.error('Error loading dex tokens from localStorage:', error);
            this.dexTokens = new Map();
        }
    }

    saveDexTokensToStorage() {
        try {
            // Convert Map to array for storage
            const dexTokensArray = Array.from(this.dexTokens.entries());
            localStorage.setItem('dexTokens', JSON.stringify(dexTokensArray));
        } catch (error) {
            console.error('Error saving dex tokens to localStorage:', error);
        }
    }

    loadSettingsFromStorage() {
        try {
            const stored = localStorage.getItem('tokenAlertSettings');
            if (stored) {
                this.settings = { ...this.settings, ...JSON.parse(stored) };
                // Update UI to reflect loaded settings
                this.updateSettingsButtons();
                this.updateVolumeSlider();
                this.applyTheme(this.settings.theme || 'pump');
            } else {
                // Apply default theme if no settings found
                this.applyTheme('pump');
            }
        } catch (error) {
            console.error('Error loading settings from localStorage:', error);
            this.applyTheme('pump');
        }
    }

    updateVolumeSlider() {
        if (this.alertVolumeSlider && this.volumeValue) {
            this.alertVolumeSlider.value = this.settings.alertVolume || 50;
            this.volumeValue.textContent = `${this.settings.alertVolume || 50}%`;
        }
    }

    updateSettingsButtons() {
        const activeValue = this.settings.tokenClickOption || 'pumpfun';
        this.settingsOptionButtons.forEach(btn => {
            if (btn.getAttribute('data-value') === activeValue) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // Update theme buttons
        const activeTheme = this.settings.theme || 'pump';
        this.themeButtons.forEach(btn => {
            if (btn.getAttribute('data-theme') === activeTheme) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    applyTheme(theme) {
        if (!theme) theme = 'pump';
        document.body.setAttribute('data-theme', theme);
        this.settings.theme = theme;
    }

    saveSettingsToStorage() {
        try {
            localStorage.setItem('tokenAlertSettings', JSON.stringify(this.settings));
        } catch (error) {
            console.error('Error saving settings to localStorage:', error);
        }
    }

    getTokenUrl(mint) {
        switch(this.settings.tokenClickOption) {
            case 'pumpfun':
                return `https://pump.fun/${mint}`;
            case 'pumpfun-advanced':
                return `https://pump.fun/advanced/coin/${mint}`;
            case 'gmgn':
                return `https://gmgn.ai/sol/token/${mint}`;
            case 'axiom':
                return `https://axiom.trade/t/${mint}`;
            case 'copy-ca':
                return null; // Special case - will be handled by handleTokenClick
            default:
                return `https://pump.fun/${mint}`;
        }
    }

    async handleTokenClick(mint) {
        if (this.settings.tokenClickOption === 'copy-ca') {
            try {
                await navigator.clipboard.writeText(mint);
                // Visual feedback could be added here (toast notification, etc.)
                console.log('Mint address copied to clipboard:', mint);
            } catch (error) {
                console.error('Failed to copy to clipboard:', error);
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = mint;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                document.body.appendChild(textArea);
                textArea.select();
                try {
                    document.execCommand('copy');
                    console.log('Mint address copied to clipboard (fallback):', mint);
                } catch (err) {
                    console.error('Fallback copy failed:', err);
                }
                document.body.removeChild(textArea);
            }
        } else {
            const url = this.getTokenUrl(mint);
            if (url) {
                window.open(url, '_blank');
            }
        }
    }

    initEventListeners() {
        // Create Alert button - open modal
        this.createAlertBtn.addEventListener('click', () => {
            this.openCreateModal();
        });

        // Edit Alerts button - open modal
        this.editAlertsBtn.addEventListener('click', () => {
            this.openEditModal();
        });

        // Settings button - open modal
        this.settingsBtn.addEventListener('click', () => {
            this.openSettingsModal();
        });

        // Close settings modal button
        this.closeSettingsModalBtn.addEventListener('click', () => {
            this.closeSettingsModal();
        });

        // DM Alerts button - open modal
        this.dmAlertsBtn.addEventListener('click', () => {
            this.openDmAlertsModal();
        });

        // Close DM Alerts modal button
        if (this.closeDmAlertsBtn) {
            this.closeDmAlertsBtn.addEventListener('click', () => {
                this.closeDmAlertsModal();
            });
        }
        
        // DM Alerts slideshow handlers
        if (this.checkUsernameBtn) {
            this.checkUsernameBtn.addEventListener('click', () => this.checkUsername());
        }
        if (this.createProfileOptionBtn) {
            this.createProfileOptionBtn.addEventListener('click', () => this.showDmAlertsSlide(1));
        }
        if (this.loginOptionBtn) {
            this.loginOptionBtn.addEventListener('click', () => {
                this.showDmAlertsSlide(3);
                const loginForm = document.getElementById('loginForm');
                const profileActions = document.getElementById('profileActions');
                if (loginForm) loginForm.style.display = 'block';
                if (profileActions) profileActions.style.display = 'none';
            });
        }
        if (this.createProfileBtn) {
            this.createProfileBtn.addEventListener('click', () => this.createProfile());
        }
        if (this.backToUsernameBtn) {
            this.backToUsernameBtn.addEventListener('click', () => this.showDmAlertsSlide(1));
        }
        if (this.backToOptionsBtn) {
            this.backToOptionsBtn.addEventListener('click', () => this.showDmAlertsSlide(0));
        }
        if (this.backToOptionsFromLoginBtn) {
            this.backToOptionsFromLoginBtn.addEventListener('click', () => this.showDmAlertsSlide(0));
        }
        if (this.loginBtn) {
            this.loginBtn.addEventListener('click', () => this.loginUser());
        }
        if (this.logoutBtn) {
            this.logoutBtn.addEventListener('click', () => this.logoutUser());
        }
        if (this.linkTelegramBtn) {
            this.linkTelegramBtn.addEventListener('click', () => this.linkTelegram());
        }
        
        // Allow Enter key to submit forms
        if (this.usernameInput) {
            this.usernameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.checkUsername();
            });
        }
        if (this.passwordInput) {
            this.passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.createProfile();
            });
        }
        if (this.loginUsername) {
            this.loginUsername.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.loginUser();
            });
        }
        if (this.loginPassword) {
            this.loginPassword.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.loginUser();
            });
        }

        // Help button - open modal
        this.helpBtn.addEventListener('click', () => {
            this.helpModal.classList.add('active');
            document.body.style.overflow = 'hidden';
        });

        // Close Help modal buttons
        if (this.closeHelpBtn) {
            this.closeHelpBtn.addEventListener('click', () => {
                this.helpModal.classList.remove('active');
                document.body.style.overflow = '';
            });
        }
        if (this.closeHelpBtn2) {
            this.closeHelpBtn2.addEventListener('click', () => {
                this.helpModal.classList.remove('active');
                document.body.style.overflow = '';
            });
        }

        // Close modals when clicking overlay
        if (this.dmAlertsModal) {
            this.dmAlertsModal.addEventListener('click', (e) => {
                if (e.target === this.dmAlertsModal) {
                    this.dmAlertsModal.classList.remove('active');
                    document.body.style.overflow = '';
                }
            });
        }
        if (this.helpModal) {
            this.helpModal.addEventListener('click', (e) => {
                if (e.target === this.helpModal) {
                    this.helpModal.classList.remove('active');
                    document.body.style.overflow = '';
                }
            });
        }

        // Save settings button
        this.saveSettingsBtn.addEventListener('click', () => {
            this.saveSettings();
        });

        // Settings option button clicks (for token click options)
        this.settingsOptionButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // Remove active class from all buttons
                this.settingsOptionButtons.forEach(b => b.classList.remove('active'));
                // Add active class to clicked button
                btn.classList.add('active');
                // Update setting
                this.settings.tokenClickOption = btn.getAttribute('data-value');
            });
        });

        // Theme button clicks
        this.themeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // Remove active class from all theme buttons
                this.themeButtons.forEach(b => b.classList.remove('active'));
                // Add active class to clicked button
                btn.classList.add('active');
                // Apply theme immediately
                const theme = btn.getAttribute('data-theme');
                this.applyTheme(theme);
            });
        });

        // Volume slider input - update display without playing sound
        this.alertVolumeSlider.addEventListener('input', (e) => {
            const volume = parseInt(e.target.value);
            this.volumeValue.textContent = `${volume}%`;
            this.settings.alertVolume = volume;
        });

        // Volume slider change - play sound when mouse is released
        this.alertVolumeSlider.addEventListener('change', (e) => {
            const volume = parseInt(e.target.value);
            this.volumeValue.textContent = `${volume}%`;
            this.settings.alertVolume = volume;
            // Play test sound only when mouse is released
            this.playAlertSound();
        });

        // Dex token placeholder click handlers
        document.querySelectorAll('.dex-token-placeholder').forEach(placeholder => {
            placeholder.addEventListener('click', () => {
                const slot = parseInt(placeholder.getAttribute('data-slot'));
                this.handleDexTokenPlaceholderClick(slot);
            });
        });

        // Dex token input modal event listeners
        this.confirmDexTokenInputBtn.addEventListener('click', () => this.confirmDexTokenInput());
        this.cancelDexTokenInputBtn.addEventListener('click', () => this.closeDexTokenInputModal());
        this.closeDexTokenInputBtn.addEventListener('click', () => this.closeDexTokenInputModal());
        
        // Close dex token input modal when clicking overlay
        this.dexTokenInputModal.addEventListener('click', (e) => {
            if (e.target === this.dexTokenInputModal) {
                this.closeDexTokenInputModal();
            }
        });

        // Allow Enter key to submit
        this.dexTokenMintInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.confirmDexTokenInput();
            }
        });

        // Close settings modal when clicking overlay
        this.settingsModal.addEventListener('click', (e) => {
            if (e.target === this.settingsModal) {
                this.closeSettingsModal();
            }
        });

        // Delete confirmation modal event listeners
        this.confirmDeleteBtn.addEventListener('click', () => this.confirmDeleteAlert());
        this.cancelDeleteBtn.addEventListener('click', () => this.closeDeleteConfirmModal());
        this.closeDeleteConfirmBtn.addEventListener('click', () => this.closeDeleteConfirmModal());
        
        // Close delete confirmation modal when clicking overlay
        this.deleteConfirmModal.addEventListener('click', (e) => {
            if (e.target === this.deleteConfirmModal) {
                this.closeDeleteConfirmModal();
            }
        });

        // Clear All Token Cards button
        this.clearAllTokensBtn.addEventListener('click', () => {
            if (this.matchedTokens.size === 0) {
                return; // No tokens to clear
            }
            this.clearAllTokensConfirmModal.classList.add('active');
            document.body.style.overflow = 'hidden';
        });

        // Clear All Token Cards confirmation buttons
        this.confirmClearAllTokensBtn.addEventListener('click', () => this.confirmClearAllTokens());
        this.cancelClearAllTokensBtn.addEventListener('click', () => this.closeClearAllTokensConfirmModal());
        this.closeClearAllTokensConfirmBtn.addEventListener('click', () => this.closeClearAllTokensConfirmModal());
        
        // Close clear all tokens confirmation modal when clicking overlay
        this.clearAllTokensConfirmModal.addEventListener('click', (e) => {
            if (e.target === this.clearAllTokensConfirmModal) {
                this.closeClearAllTokensConfirmModal();
            }
        });

        // Close create modal button
        this.closeModalBtn.addEventListener('click', () => {
            this.closeCreateModal();
        });

        // Close edit modal button
        this.closeEditModalBtn.addEventListener('click', () => {
            this.closeEditModal();
        });

        // Cancel button
        this.cancelBtn.addEventListener('click', () => {
            this.closeCreateModal();
        });

        // Close create modal when clicking overlay
        this.createAlertModal.addEventListener('click', (e) => {
            if (e.target === this.createAlertModal) {
                this.closeCreateModal();
            }
        });

        // Close edit modal when clicking overlay
        this.editAlertsModal.addEventListener('click', (e) => {
            if (e.target === this.editAlertsModal) {
                this.closeEditModal();
            }
        });

        // Tab switching in edit alerts modal
        this.alertTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.getAttribute('data-tab');
                this.switchAlertTab(tabName);
            });
        });

        // Alert type button clicks in modal
        document.querySelectorAll('.modal-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.getAttribute('data-type');
                
                document.querySelectorAll('.modal-action-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                
                this.alertType.value = type;
                this.formFieldsSection.classList.add('active');
                this.updateFormFields(type);
                
                // Scroll form fields into view
                setTimeout(() => {
                    this.formFieldsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 100);
            });
        });

        // Form submission
        this.alertForm.addEventListener('submit', (e) => {
            e.preventDefault();
            
            const type = this.alertType.value;
            const valueInput = document.getElementById('alertValue');
            const thresholdInput = document.getElementById('alertThreshold');
            const percentageInput = document.getElementById('alertPercentage');
            const nameInput = document.getElementById('alertName');
            
            let value = valueInput.value.trim();
            const threshold = thresholdInput.value.trim();
            const percentage = percentageInput.value.trim();
            const name = nameInput.value.trim();

            if (!type) {
                window.alert('Please select an alert type');
                return;
            }

            // Check required fields based on alert type
            if (type === 'deployer-marketcap') {
                if (!threshold) {
                    window.alert('Please enter a market cap threshold');
                    return;
                }
            } else if (type === 'deployer-bonded') {
                if (!percentage) {
                    window.alert('Please enter a percentage');
                    return;
                }
            } else {
                if (!value) {
                    window.alert('Please fill in all required fields');
                    return;
                }
            }

            if (type === 'twitter-handle' && value.startsWith('@')) {
                value = value.substring(1);
            }

            const alertData = {
                type: type,
                value: value || null // Allow null for marketcap/bonded alerts
            };

            if (type === 'deployer-marketcap' && threshold) {
                alertData.threshold = parseFloat(threshold);
            } else if (type === 'deployer-bonded' && percentage) {
                alertData.percentage = parseFloat(percentage);
            }
            
            // Add name for developer alerts if provided
            if ((type === 'deployer-match' || type === 'deployer-marketcap' || type === 'deployer-bonded') && name) {
                alertData.name = name;
            }

            // Add alert locally
            const newAlert = {
                id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                ...alertData,
                enabled: true,
                createdAt: Date.now()
            };
            this.alerts.push(newAlert);
            this.renderAlerts();
            
            // Auto-save to profile if logged in
            if (this.currentUser) {
                this.autoSaveAlerts();
            }
            
            // Reset and close modal
            this.resetForm();
            this.closeCreateModal();
        });
    }

    openCreateModal() {
        this.createAlertModal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }

    closeCreateModal() {
        this.createAlertModal.classList.remove('active');
        document.body.style.overflow = ''; // Restore scrolling
        this.resetForm();
    }

    openEditModal() {
        this.renderAlertsInModal();
        this.switchAlertTab('token'); // Start with token alerts tab
        this.editAlertsModal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }

    closeEditModal() {
        this.editAlertsModal.classList.remove('active');
        document.body.style.overflow = ''; // Restore scrolling
    }

    openSettingsModal() {
        // Update UI to reflect current settings
        this.updateSettingsButtons();
        this.updateVolumeSlider();
        this.settingsModal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }

    closeSettingsModal() {
        this.settingsModal.classList.remove('active');
        document.body.style.overflow = ''; // Restore scrolling
    }

    saveSettings() {
        // Get the selected option from the active button
        const activeButton = document.querySelector('.settings-option-btn.active');
        if (activeButton) {
            this.settings.tokenClickOption = activeButton.getAttribute('data-value');
        }
        // Volume is already saved on slider change, but save it again to be sure
        this.settings.alertVolume = parseInt(this.alertVolumeSlider.value);
        this.saveSettingsToStorage();
        this.closeSettingsModal();
    }

    switchAlertTab(tabName) {
        // Update tab buttons
        this.alertTabs.forEach(tab => {
            if (tab.getAttribute('data-tab') === tabName) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        // Update tab content
        document.querySelectorAll('.alerts-tab-content').forEach(content => {
            content.classList.remove('active');
        });

        const activeTabContent = document.getElementById(`${tabName}AlertsTab`);
        if (activeTabContent) {
            activeTabContent.classList.add('active');
        }

        // Re-render the active tab
        this.renderAlertsInModal();
    }

    getAlertCategory(alertType) {
        const tokenTypes = ['ticker-exact', 'ticker-contains', 'name-exact', 'name-contains'];
        const developerTypes = ['deployer-match', 'deployer-marketcap', 'deployer-bonded'];
        const socialTypes = ['twitter-handle', 'website-contains'];

        if (tokenTypes.includes(alertType)) return 'token';
        if (developerTypes.includes(alertType)) return 'developer';
        if (socialTypes.includes(alertType)) return 'social';
        return 'token'; // Default
    }

    renderAlertsInModal() {
        // Get active tab
        const activeTab = document.querySelector('.alert-tab.active');
        const activeTabName = activeTab ? activeTab.getAttribute('data-tab') : 'token';
        
        // Filter alerts by category
        const tokenAlerts = this.alerts.filter(a => this.getAlertCategory(a.type) === 'token');
        const developerAlerts = this.alerts.filter(a => this.getAlertCategory(a.type) === 'developer');
        const socialAlerts = this.alerts.filter(a => this.getAlertCategory(a.type) === 'social');

        // Render token alerts
        this.renderAlertList(this.tokenAlertsList, tokenAlerts, 'emptyTokenCanvas', 'No token alerts created yet');

        // Render developer alerts
        this.renderAlertList(this.developerAlertsList, developerAlerts, 'emptyDeveloperCanvas', 'No developer alerts created yet');

        // Render social alerts
        this.renderAlertList(this.socialAlertsList, socialAlerts, 'emptySocialCanvas', 'No social alerts created yet');
    }

    renderAlertList(container, alerts, canvasId, emptyMessage) {
        if (alerts.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <canvas id="${canvasId}" width="80" height="80"></canvas>
                    <p>${emptyMessage}</p>
                </div>
            `;
            // Draw empty canvas icon
            const emptyCanvas = document.getElementById(canvasId);
            if (emptyCanvas) {
                const ctx = emptyCanvas.getContext('2d');
                ctx.strokeStyle = '#888';
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                const centerX = 40;
                const centerY = 40;
                ctx.beginPath();
                ctx.moveTo(centerX - 15, centerY - 10);
                ctx.lineTo(centerX - 10, centerY + 15);
                ctx.lineTo(centerX + 10, centerY + 15);
                ctx.lineTo(centerX + 15, centerY - 10);
                ctx.arc(centerX, centerY - 10, 15, Math.PI, 0, false);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(centerX, centerY + 5, 3, 0, Math.PI * 2);
                ctx.stroke();
            }
            return;
        }

        container.innerHTML = alerts.map(alert => `
            <div class="alert-item-modal ${alert.enabled ? 'active' : 'disabled'}">
                <div class="alert-info-modal">
                    <div class="alert-name-modal">${this.escapeHtml(this.getAlertDescription(alert))}</div>
                </div>
                <div class="alert-actions-modal">
                    <button class="btn btn-small delete" onclick="app.deleteAlert('${alert.id}'); app.renderAlertsInModal();">Delete</button>
                    <button class="btn btn-small btn-primary" onclick="app.toggleAlert('${alert.id}'); app.renderAlertsInModal();">${alert.enabled ? 'Disable' : 'Enable'}</button>
                </div>
            </div>
        `).join('');
    }

    resetForm() {
        this.alertForm.reset();
        this.formFieldsSection.classList.remove('active');
        document.querySelectorAll('.modal-action-btn').forEach(b => b.classList.remove('selected'));
        this.valueGroup.style.display = 'block';
        this.thresholdGroup.style.display = 'none';
        this.percentageGroup.style.display = 'none';
        this.nameGroup.style.display = 'none';
        document.getElementById('alertThreshold').required = false;
        document.getElementById('alertPercentage').required = false;
        document.getElementById('alertValue').required = false; // Will be set by updateFormFields when needed
        document.getElementById('alertName').required = false;
    }

    updateFormFields(type) {
        this.valueGroup.style.display = 'block';
        this.thresholdGroup.style.display = 'none';
        this.percentageGroup.style.display = 'none';
        this.nameGroup.style.display = 'none';
        
        const thresholdInput = document.getElementById('alertThreshold');
        const percentageInput = document.getElementById('alertPercentage');
        const valueInput = document.getElementById('alertValue');
        const nameInput = document.getElementById('alertName');
        
        thresholdInput.required = false;
        percentageInput.required = false;
        valueInput.required = false;
        nameInput.required = false;

        const valueLabel = document.getElementById('valueLabel');
        const alertValue = document.getElementById('alertValue');

        if (type === 'ticker-exact' || type === 'ticker-contains') {
            valueLabel.textContent = 'Ticker';
            alertValue.placeholder = 'Enter ticker symbol...';
            alertValue.type = 'text';
            alertValue.required = true;
        } else if (type === 'name-exact' || type === 'name-contains') {
            valueLabel.textContent = 'Name';
            alertValue.placeholder = 'Enter token name...';
            alertValue.type = 'text';
            alertValue.required = true;
        } else if (type === 'deployer-match') {
            valueLabel.textContent = 'Developer Wallet Address';
            alertValue.placeholder = 'Enter wallet address...';
            alertValue.type = 'text';
            alertValue.required = true;
            this.nameGroup.style.display = 'block';
        } else if (type === 'deployer-marketcap') {
            this.valueGroup.style.display = 'none';
            this.thresholdGroup.style.display = 'block';
            this.nameGroup.style.display = 'none';
            thresholdInput.required = true;
            document.getElementById('alertThresholdLabel').textContent = 'Market Cap Threshold (USD)';
            thresholdInput.placeholder = 'Enter market cap in USD...';
        } else if (type === 'deployer-bonded') {
            this.valueGroup.style.display = 'none';
            this.percentageGroup.style.display = 'block';
            this.nameGroup.style.display = 'none';
            const percentageInputField = document.getElementById('alertPercentage');
            percentageInputField.required = true;
        } else if (type === 'twitter-handle') {
            valueLabel.textContent = 'Twitter Username';
            alertValue.placeholder = 'Enter Twitter username (without @)...';
            alertValue.type = 'text';
            alertValue.required = true;
        } else if (type === 'website-contains') {
            valueLabel.textContent = 'Website URL Phrase';
            alertValue.placeholder = 'Enter phrase to search in website URL...';
            alertValue.type = 'text';
            alertValue.required = true;
        }
    }

    renderAlerts() {
        // Render dex tokens instead of empty state
        this.renderDexTokens();
    }

    handleDexTokenPlaceholderClick(slot) {
        this.pendingDexSlot = slot;
        this.dexTokenMintInput.value = '';
        this.dexTokenInputModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        // Focus the input after modal opens
        setTimeout(() => {
            this.dexTokenMintInput.focus();
        }, 100);
    }

    confirmDexTokenInput() {
        const mintAddress = this.dexTokenMintInput.value.trim();
        if (mintAddress && this.pendingDexSlot !== null) {
            // Request token data from server
            this.socket.emit('dex:fetch-token', {
                slot: this.pendingDexSlot,
                mint: mintAddress
            });
        }
        this.closeDexTokenInputModal();
    }

    closeDexTokenInputModal() {
        this.dexTokenInputModal.classList.remove('active');
        document.body.style.overflow = '';
        this.pendingDexSlot = null;
        this.dexTokenMintInput.value = '';
    }

    renderDexTokens() {
        const container = this.alertsContainer;
        const slots = [0, 1, 2];
        
        container.innerHTML = slots.map(slot => {
            const token = this.dexTokens.get(slot);
            
            if (token) {
                // Render token card
                const imageUrl = token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null;
                const symbolText = token.symbol ? token.symbol.substring(0, 4).toUpperCase() : '?';
                
                // Generate placeholder color
                const colors = [
                    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
                    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
                    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
                ];
                const colorIndex = token.symbol ? token.symbol.charCodeAt(0) % colors.length : 0;
                
                // Marketcap in USD
                const marketCapUSD = token.marketCapUSD ? 
                    `$${token.marketCapUSD.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}` : 
                    'N/A';
                
                // Social links
                const hasTwitter = token.twitter && token.twitter.trim().length > 0;
                const hasWebsite = token.website && token.website.trim().length > 0;
                const hasTelegram = token.telegram && token.telegram.trim().length > 0;
                
                return `
                    <div class="dex-token-card" data-slot="${slot}" data-mint="${token.mint}">
                        <div class="dex-token-main-content">
                            <div class="dex-token-header-row">
                                <div class="token-image-wrapper">
                                    ${imageUrl ? 
                                        `<img src="" data-src="${imageUrl}" alt="${token.name || ''}" style="display: none; visibility: hidden;">
                                         <div class="token-image-placeholder" style="background: ${colors[colorIndex]};">${symbolText}</div>` :
                                        `<div class="token-image-placeholder" style="background: ${colors[colorIndex]};">${symbolText}</div>`
                                    }
                                </div>
                                <div class="token-name-section">
                                    <div class="token-name-large">${this.escapeHtml(token.name || 'Unknown')}</div>
                                    <div class="token-symbol-large">${this.escapeHtml(token.symbol || 'N/A')}</div>
                                </div>
                                <div class="dex-token-right-section">
                                    <div class="token-marketcap">${marketCapUSD}</div>
                                    <div class="token-social-links">
                                        <a href="${hasTwitter ? token.twitter : '#'}" 
                                           target="_blank" 
                                           class="social-link twitter ${!hasTwitter ? 'disabled' : ''}" 
                                           data-tooltip="Twitter"
                                           onclick="event.stopPropagation(); ${!hasTwitter ? 'return false;' : ''}">🐦</a>
                                        <a href="${hasWebsite ? token.website : '#'}" 
                                           target="_blank" 
                                           class="social-link website ${!hasWebsite ? 'disabled' : ''}" 
                                           data-tooltip="Website"
                                           onclick="event.stopPropagation(); ${!hasWebsite ? 'return false;' : ''}">🌐</a>
                                        <a href="${hasTelegram ? token.telegram : '#'}" 
                                           target="_blank" 
                                           class="social-link telegram ${!hasTelegram ? 'disabled' : ''}" 
                                           data-tooltip="Telegram"
                                           onclick="event.stopPropagation(); ${!hasTelegram ? 'return false;' : ''}">💬</a>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <button class="dex-token-delete-btn" onclick="event.stopPropagation(); app.deleteDexToken(${slot});" title="Remove token">×</button>
                    </div>
                `;
            } else {
                // Render placeholder
                return `
                    <div class="dex-token-placeholder" data-slot="${slot}">
                        <div class="placeholder-content">
                            <div class="placeholder-icon">+</div>
                            <div class="placeholder-text">Click to add token</div>
                        </div>
                    </div>
                `;
            }
        }).join('');
        
        // Re-attach click handlers for placeholders
        document.querySelectorAll('.dex-token-placeholder').forEach(placeholder => {
            placeholder.addEventListener('click', () => {
                const slot = parseInt(placeholder.getAttribute('data-slot'));
                this.handleDexTokenPlaceholderClick(slot);
            });
        });
        
        // Add click handlers for token cards (to open pump.fun)
        document.querySelectorAll('.dex-token-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't navigate if clicking on social links or delete button
                if (e.target.closest('.social-link') || e.target.closest('.dex-token-delete-btn')) {
                    return;
                }
                const mint = card.getAttribute('data-mint');
                if (mint) {
                    this.handleTokenClick(mint);
                }
            });
            
            // Attach social link tooltip handlers
            card.querySelectorAll('.social-link').forEach(link => {
                if (!link.dataset.tooltipHandlerAttached) {
                    link.dataset.tooltipHandlerAttached = 'true';
                    const url = link.getAttribute('href');
                    if (url && url !== '#') {
                        link.addEventListener('mouseenter', (e) => {
                            this.showSocialTooltip(e, url);
                        });
                        link.addEventListener('mouseleave', () => {
                            this.hideSocialTooltip();
                        });
                    }
                }
            });
        });
        
        // Handle image loading with delay for dex tokens
        setTimeout(() => {
            document.querySelectorAll('.dex-token-card img[data-src]').forEach(img => {
                const src = img.getAttribute('data-src');
                if (src) {
                    // Check if this image has already been loaded
                    if (this.loadedImages.has(src) && img.complete && img.naturalWidth > 0) {
                        // Image was already loaded, restore it immediately
                        img.src = src;
                        img.style.display = 'block';
                        img.style.visibility = 'visible';
                        const placeholder = img.nextElementSibling;
                        if (placeholder && placeholder.classList.contains('token-image-placeholder')) {
                            placeholder.style.display = 'none';
                        }
                    } else if (img.src && img.complete && img.naturalWidth > 0) {
                        // Image is already loaded (checking current src), preserve it
                        img.style.display = 'block';
                        img.style.visibility = 'visible';
                        const placeholder = img.nextElementSibling;
                        if (placeholder && placeholder.classList.contains('token-image-placeholder')) {
                            placeholder.style.display = 'none';
                        }
                        this.loadedImages.add(src);
                    } else {
                        // Image hasn't been loaded yet, initialize loading
                        const tempImg = new Image();
                        tempImg.onload = () => {
                            this.loadedImages.add(src); // Mark as loaded
                            img.src = src;
                            img.style.display = 'block';
                            img.style.visibility = 'visible';
                            const placeholder = img.nextElementSibling;
                            if (placeholder && placeholder.classList.contains('token-image-placeholder')) {
                                placeholder.style.display = 'none';
                            }
                        };
                        tempImg.onerror = () => {
                            // Keep placeholder on error
                            img.style.display = 'none';
                        };
                        tempImg.src = src;
                    }
                }
            });
        }, 1000);

        // Start DexScreener checks if we have tokens and checks aren't running
        if (this.dexTokens.size > 0 && !this.dexScreenerCheckInterval) {
            this.startDexScreenerChecks();
        }
    }

    deleteDexToken(slot) {
        this.dexTokens.delete(slot);
        this.dexScreenerStatuses.delete(slot);
        this.saveDexTokensToStorage(); // Save to localStorage
        this.renderDexTokens();
        // If no tokens left, stop the update intervals
        if (this.dexTokens.size === 0) {
            this.stopDexTokenUpdates();
            this.stopDexScreenerChecks();
        } else {
            // Restart checks with new interval based on token count
            this.stopDexScreenerChecks();
            this.startDexScreenerChecks();
        }
    }

    startDexTokenUpdates() {
        // Only start if there are tokens and interval is not already running
        if (this.dexTokens.size === 0) {
            return;
        }
        if (this.dexTokenUpdateInterval) {
            return;
        }
        
        // Update immediately, then every 5 seconds
        this.updateDexTokenMarketcaps();
        this.dexTokenUpdateInterval = setInterval(() => {
            this.updateDexTokenMarketcaps();
        }, 5000);
    }

    stopDexTokenUpdates() {
        if (this.dexTokenUpdateInterval) {
            clearInterval(this.dexTokenUpdateInterval);
            this.dexTokenUpdateInterval = null;
        }
    }

    updateDexTokenMarketcaps() {
        // Only update if there are tokens
        if (this.dexTokens.size === 0) {
            return;
        }

        // Collect all mints and their slots
        const tokensToUpdate = [];
        for (const [slot, token] of this.dexTokens.entries()) {
            if (token.mint) {
                tokensToUpdate.push({ slot, mint: token.mint });
            }
        }

        // Request updates for all tokens
        if (tokensToUpdate.length > 0) {
            this.socket.emit('dex:update-tokens', { tokens: tokensToUpdate });
        }
    }

    updateDexTokenMarketcap(slot, marketCapUSD) {
        // Find the token card for this slot
        const card = this.alertsContainer.querySelector(`.dex-token-card[data-slot="${slot}"]`);
        if (!card) {
            return;
        }

        // Find the marketcap value element (for dex cards, it's in .token-marketcap)
        const marketcapValue = card.querySelector('.token-marketcap');
        if (marketcapValue) {
            const formattedValue = marketCapUSD ? 
                `$${marketCapUSD.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}` : 
                'N/A';
            marketcapValue.textContent = formattedValue;
        }
    }

    startDexScreenerChecks() {
        // Only start if there are tokens and interval is not already running
        if (this.dexTokens.size === 0) {
            return;
        }
        if (this.dexScreenerCheckInterval) {
            return;
        }

        // Calculate interval based on token count: 1 token = 1.05s, 2 tokens = 2.05s, 3 tokens = 3.05s
        const interval = (this.dexTokens.size * 1000) + 50;
        
        // Check immediately, then every calculated interval
        this.checkDexScreenerStatuses();
        this.dexScreenerCheckInterval = setInterval(() => {
            this.checkDexScreenerStatuses();
        }, interval);
    }

    stopDexScreenerChecks() {
        if (this.dexScreenerCheckInterval) {
            clearInterval(this.dexScreenerCheckInterval);
            this.dexScreenerCheckInterval = null;
        }
    }

    async checkDexScreenerStatuses() {
        if (this.dexTokens.size === 0) {
            return;
        }

        // Check each token
        for (const [slot, token] of this.dexTokens.entries()) {
            if (!token.mint) {
                continue;
            }

            try {
                const url = `https://api.dexscreener.com/orders/v1/solana/${token.mint}`;
                const response = await fetch(url);
                if (!response.ok) {
                    continue;
                }

                const data = await response.json();
                if (Array.isArray(data) && data.length > 0) {
                    const status = data[0].status;
                    if (status) {
                        this.handleDexScreenerStatus(slot, token, status);
                    }
                }
            } catch (error) {
                // Silent fail - only log if needed for debugging
            }
        }
    }

    handleDexScreenerStatus(slot, token, status) {
        const statusSet = this.dexScreenerStatuses.get(slot) || new Set();
        const hadStatus = statusSet.has(status);
        
        // Update token with status
        token.dexScreenerStatus = status;
        this.dexTokens.set(slot, token);
        this.saveDexTokensToStorage(); // Save to localStorage

        // Handle positive statuses (processing, approved) - play alert once per status
        if ((status === 'processing' || status === 'approved') && !hadStatus) {
            statusSet.add(status);
            this.dexScreenerStatuses.set(slot, statusSet);
            this.playDexAlertSound(false); // Positive dex alert sound
            this.updateDexTokenCardStatus(slot, status);
        }
        // Handle cancelled status - always play negative alert and update
        else if (status === 'cancelled') {
            if (!hadStatus) {
                statusSet.add(status);
                this.dexScreenerStatuses.set(slot, statusSet);
                this.playDexAlertSound(true); // Negative dex alert sound
            }
            this.updateDexTokenCardStatus(slot, status);
        }
        // Update visual status even if we've already alerted
        else {
            this.updateDexTokenCardStatus(slot, status);
        }
    }

    updateDexTokenCardStatus(slot, status) {
        const card = this.alertsContainer.querySelector(`.dex-token-card[data-slot="${slot}"]`);
        if (!card) {
            return;
        }

        // Remove all status classes
        card.classList.remove('dex-status-processing', 'dex-status-approved', 'dex-status-cancelled');

        // Add appropriate status class
        if (status === 'processing') {
            card.classList.add('dex-status-processing');
        } else if (status === 'approved') {
            card.classList.add('dex-status-approved');
        } else if (status === 'cancelled') {
            card.classList.add('dex-status-cancelled');
        }
    }

    getAlertDescription(alert) {
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
                const walletAddress = alert.value || '';
                const shortAddress = walletAddress.length > 8 ? `${walletAddress.substring(0, 8)}...` : walletAddress;
                if (alert.name) {
                    return `${alert.name}\n${shortAddress}`;
                }
                return `Developer wallet matches\n${shortAddress}`;
            case 'deployer-marketcap':
                const threshold = alert.threshold?.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0}) || '0';
                if (alert.name) {
                    return `${alert.name}\n$${threshold} Marketcap`;
                }
                return `Dev Token Above\n$${threshold} Marketcap`;
            case 'deployer-bonded':
                if (alert.name) {
                    return `${alert.name}\n${alert.percentage}% Bonded`;
                }
                return `Developer has\n${alert.percentage}% tokens bonded`;
            case 'twitter-handle':
                return `Twitter handle matches "@${alert.value}"`;
            case 'website-contains':
                return `Website contains "${alert.value}"`;
            default:
                return 'Unknown alert type';
        }
    }

    deleteAlert(id) {
        // Store the alert ID to delete
        this.pendingDeleteId = id;
        // Show confirmation modal
        this.deleteConfirmModal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    confirmDeleteAlert() {
        if (this.pendingDeleteId) {
            this.alerts = this.alerts.filter(alert => alert.id !== this.pendingDeleteId);
            this.renderAlerts();
            // Update modal if open
            if (this.editAlertsModal.classList.contains('active')) {
                this.renderAlertsInModal();
            }
            this.pendingDeleteId = null;
            
            // Auto-save to profile if logged in
            if (this.currentUser) {
                this.autoSaveAlerts();
            }
        }
        this.closeDeleteConfirmModal();
    }

    closeDeleteConfirmModal() {
        this.deleteConfirmModal.classList.remove('active');
        document.body.style.overflow = '';
        this.pendingDeleteId = null;
    }

    confirmClearAllTokens() {
        // Clear all matched token cards (but keep alerts)
        this.matchedTokens.clear();
        this.triggeredAlerts.clear();
        this.renderMatchedTokens();
        
        // Close modal
        this.closeClearAllTokensConfirmModal();
    }

    closeClearAllTokensConfirmModal() {
        this.clearAllTokensConfirmModal.classList.remove('active');
        document.body.style.overflow = '';
    }

    toggleAlert(id) {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.enabled = !alert.enabled;
            this.renderAlerts();
            // Update modal if open
            if (this.editAlertsModal.classList.contains('active')) {
                this.renderAlertsInModal();
            }
            
            // Auto-save to profile if logged in
            if (this.currentUser) {
                this.autoSaveAlerts();
            }
        }
    }

    deleteMatchedToken(mint) {
        // Remove image from loaded images cache if it exists
        const token = this.matchedTokens.get(mint);
        if (token) {
            const imageUrl = token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null;
            if (imageUrl) {
                this.loadedImages.delete(imageUrl);
            }
        }
        this.matchedTokens.delete(mint);
        // Remove all triggered alerts for this token
        for (const key of this.triggeredAlerts) {
            if (key.startsWith(`${mint}-`)) {
                this.triggeredAlerts.delete(key);
            }
        }
        this.renderMatchedTokens();
    }

    renderMatchedTokens() {
        if (this.matchedTokens.size === 0) {
            this.matchedTokensContainer.innerHTML = `
                <div class="empty-state">
                    <canvas id="emptyTokensCanvas" width="80" height="80"></canvas>
                    <p>No matched tokens yet</p>
                </div>
            `;
            // Draw empty canvas icon
            const emptyCanvas = document.getElementById('emptyTokensCanvas');
            if (emptyCanvas) {
                const ctx = emptyCanvas.getContext('2d');
                ctx.strokeStyle = '#888';
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                const centerX = 40;
                const centerY = 40;
                // Draw coin/token icon
                ctx.beginPath();
                ctx.arc(centerX, centerY, 20, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(centerX, centerY, 12, 0, Math.PI * 2);
                ctx.stroke();
            }
            return;
        }

        const tokens = Array.from(this.matchedTokens.values());
        // Sort by most recent first
        tokens.sort((a, b) => (b.triggeredAt || 0) - (a.triggeredAt || 0));

        // Get existing cards to preserve DOM elements
        const existingCards = new Map();
        this.matchedTokensContainer.querySelectorAll('.token-card').forEach(card => {
            const mint = card.getAttribute('data-mint');
            if (mint) {
                existingCards.set(mint, card);
            }
        });

        // Build new HTML for tokens
        const newHTML = tokens.map(token => {
            const cardHTML = this.getTokenCardHTML(token);
            const matchedAlert = token.alertId ? this.alerts.find(a => a.id === token.alertId) : null;
            const alertDescription = matchedAlert ? this.getAlertDescription(matchedAlert) : 'Unknown alert';
            
            return `
                <div class="token-card-wrapper">
                    <div class="token-alert-badge-above" title="${this.escapeHtml(alertDescription)}">${this.escapeHtml(alertDescription)}</div>
                    ${cardHTML}
                </div>
            `;
        }).join('');

        // Update existing cards in place to preserve hover states
        const tokensToUpdate = [];
        const tokensToAdd = [];
        const existingMintSet = new Set(existingCards.keys());
        const currentMintSet = new Set(tokens.map(t => t.mint));
        
        // Check if order changed
        const existingCardsArray = Array.from(this.matchedTokensContainer.querySelectorAll('.token-card'));
        const orderChanged = existingCardsArray.length !== tokens.length || 
            existingCardsArray.some((card, index) => {
                const mint = card.getAttribute('data-mint');
                return tokens[index]?.mint !== mint;
            });
        
        tokens.forEach(token => {
            const existingCard = existingCards.get(token.mint);
            if (existingCard) {
                // Card exists, update only the dynamic values
                tokensToUpdate.push({ card: existingCard, token });
            } else {
                // New token, needs to be added
                tokensToAdd.push(token);
            }
        });

        // If no new tokens and order hasn't changed, just update values in place
        if (tokensToAdd.length === 0 && !orderChanged) {
            tokensToUpdate.forEach(({ card, token }) => {
                this.updateTokenCardValues(card, token);
            });
            return; // Exit early, no DOM changes needed
        }

        // Need to rebuild DOM - update values first, then rebuild
        tokensToUpdate.forEach(({ card, token }) => {
            this.updateTokenCardValues(card, token);
        });

        // Rebuild HTML (only happens when order changes or new tokens added)
        this.matchedTokensContainer.innerHTML = newHTML;

        // Re-attach image loading with retry logic and 1 second delay, and add click handlers
        tokens.forEach(token => {
            const card = this.matchedTokensContainer.querySelector(`[data-mint="${token.mint}"]`);
            if (card) {
                // Make card clickable to open token URL based on settings
                card.addEventListener('click', (e) => {
                    // Don't navigate if clicking on social links or delete button (they handle their own actions)
                    if (e.target.closest('.social-link') || e.target.closest('.token-delete-btn')) {
                        return;
                    }
                    this.handleTokenClick(token.mint);
                });
                
                // Attach social link tooltip handlers
                card.querySelectorAll('.social-link').forEach(link => {
                    if (!link.dataset.tooltipHandlerAttached) {
                        link.dataset.tooltipHandlerAttached = 'true';
                        const url = link.getAttribute('href');
                        if (url && url !== '#') {
                            link.addEventListener('mouseenter', (e) => {
                                this.showSocialTooltip(e, url);
                            });
                            link.addEventListener('mouseleave', () => {
                                this.hideSocialTooltip();
                            });
                        }
                    }
                });
                
                const imageWrapper = card.querySelector('.token-image-wrapper');
                const img = imageWrapper?.querySelector('img');
                const placeholder = imageWrapper?.querySelector('.token-image-placeholder');
                
                if (img && placeholder && img.dataset.src) {
                    const imageUrl = img.dataset.src;
                    
                    // Check if this image has already been loaded previously
                    if (this.loadedImages.has(imageUrl)) {
                        // Image was loaded before, restore it immediately (browser cache should handle it)
                        img.src = imageUrl;
                        // Set up handlers to show image once it loads (from cache or network)
                        img.onload = () => {
                            img.style.display = 'block';
                            img.style.visibility = 'visible';
                            placeholder.style.display = 'none';
                        };
                        img.onerror = () => {
                            // If cached image fails, keep placeholder
                            img.style.display = 'none';
                            placeholder.style.display = 'flex';
                        };
                        // If image is already in cache, it might load synchronously
                        if (img.complete && img.naturalWidth > 0) {
                            img.style.display = 'block';
                            img.style.visibility = 'visible';
                            placeholder.style.display = 'none';
                        }
                    } else {
                        // Image hasn't been loaded yet, initialize loading
                        placeholder.style.display = 'flex';
                        img.style.display = 'none';
                        img.style.visibility = 'hidden';
                        
                        // Wait 1 second before attempting to load the image
                        setTimeout(() => {
                            // Check again if image was loaded in the meantime
                            if (this.loadedImages.has(imageUrl) && img.complete && img.naturalWidth > 0) {
                                img.src = imageUrl;
                                img.style.display = 'block';
                                img.style.visibility = 'visible';
                                placeholder.style.display = 'none';
                                return;
                            }
                            
                            let retryCount = 0;
                            const maxRetries = 3;
                            let imageLoaded = false;
                            
                            const tryLoad = () => {
                                // Set up error handler before loading
                                img.onerror = () => {
                                    if (imageLoaded) return; // Don't process errors after successful load
                                    retryCount++;
                                    if (retryCount < maxRetries) {
                                        setTimeout(() => {
                                            // Clear previous handlers and try again
                                            img.onerror = null;
                                            img.onload = null;
                                            img.src = imageUrl.split('?')[0] + '?v=' + Date.now() + '&retry=' + retryCount;
                                            tryLoad();
                                        }, 1000 * retryCount);
                                    } else {
                                        // All retries failed, keep placeholder visible
                                        img.style.display = 'none';
                                        img.style.visibility = 'hidden';
                                        placeholder.style.display = 'flex';
                                    }
                                };
                                
                                // Set up load handler
                                img.onload = () => {
                                    imageLoaded = true;
                                    this.loadedImages.add(imageUrl); // Mark as loaded
                                    // Only show image if it loaded successfully
                                    img.style.display = 'block';
                                    img.style.visibility = 'visible';
                                    placeholder.style.display = 'none';
                                };
                                
                                // Set the src to start loading (image stays hidden until onload fires)
                                img.src = imageUrl;
                            };
                            tryLoad();
                        }, 1000); // 1 second delay
                    }
                }
            }
        });
    }

    showSocialTooltip(event, url) {
        // Remove existing tooltip if any
        const existing = document.getElementById('socialTooltip');
        if (existing) {
            existing.remove();
        }
        
        // Don't show tooltip for disabled links
        if (event.currentTarget.classList.contains('disabled')) {
            return;
        }
        
        // Truncate Twitter/X.com status URLs
        let displayUrl = url;
        const twitterMatch = url.match(/^(https?:\/\/(?:twitter\.com|x\.com)\/[^\/]+\/status\/)/i);
        if (twitterMatch) {
            displayUrl = twitterMatch[1] + '...';
        }
        
        // Create tooltip element
        const tooltip = document.createElement('div');
        tooltip.id = 'socialTooltip';
        tooltip.className = 'social-tooltip';
        tooltip.textContent = displayUrl;
        
        document.body.appendChild(tooltip);
        
        // Position tooltip near the icon
        const rect = event.currentTarget.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        
        // Position above the icon, centered
        tooltip.style.left = `${rect.left + (rect.width / 2) - (tooltipRect.width / 2)}px`;
        tooltip.style.top = `${rect.top - tooltipRect.height - 8}px`;
        
        // Ensure tooltip stays within viewport
        const maxLeft = window.innerWidth - tooltipRect.width - 10;
        const minLeft = 10;
        if (parseInt(tooltip.style.left) > maxLeft) {
            tooltip.style.left = `${maxLeft}px`;
        }
        if (parseInt(tooltip.style.left) < minLeft) {
            tooltip.style.left = `${minLeft}px`;
        }
        
        // If tooltip would go above viewport, show below instead
        if (parseInt(tooltip.style.top) < 10) {
            tooltip.style.top = `${rect.bottom + 8}px`;
        }
    }
    
    hideSocialTooltip() {
        const tooltip = document.getElementById('socialTooltip');
        if (tooltip) {
            tooltip.remove();
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatSOL(value) {
        if (!value || value === 0) return '0';
        if (value < 0.001) return value.toFixed(6);
        if (value < 1) return value.toFixed(4);
        if (value < 1000) return value.toFixed(2);
        if (value < 1000000) return (value / 1000).toFixed(2) + 'K';
        return (value / 1000000).toFixed(2) + 'M';
    }

    formatUSD(value) {
        if (!value || value === 0) return '$0';
        if (value < 1000) return '$' + value.toFixed(2);
        if (value < 1000000) return '$' + (value / 1000).toFixed(2) + 'K';
        return '$' + (value / 1000000).toFixed(2) + 'M';
    }

    renderMetasTicker() {
        if (!this.metasTicker || !this.metasTickerContainer) {
            return;
        }

        if (!this.currentMetas || this.currentMetas.length === 0) {
            this.metasTickerContainer.style.display = 'none';
            return;
        }

        // Show the container
        this.metasTickerContainer.style.display = 'flex';

        // Create ticker items - duplicate for seamless loop
        const tickerItems = this.currentMetas.map(meta => {
            const score = meta.score || 0;
            return `
                <div class="metas-ticker-item">
                    <span class="metas-word">${this.escapeHtml(meta.word || '')}</span>
                    <span class="metas-score">${score}</span>
                </div>
            `;
        }).join('');

        // Duplicate items for seamless scrolling
        this.metasTicker.innerHTML = tickerItems + tickerItems;
    }

    getTokenCardHTML(token) {
        const imageUrl = token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null;
        const symbolText = token.symbol ? token.symbol.substring(0, 4).toUpperCase() : '?';
        
        // Generate placeholder color
        const colors = [
            'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
            'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
            'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
            'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
        ];
        const colorIndex = token.symbol ? token.symbol.charCodeAt(0) % colors.length : 0;
        
        // Get alert description
        const matchedAlert = token.alertId ? this.alerts.find(a => a.id === token.alertId) : null;
        const alertDescription = matchedAlert ? this.getAlertDescription(matchedAlert) : 'Unknown alert';
        
        // Dev buy percentage (2 decimal places)
        const devBuyPercent = token.devBuy && token.devBuy > 0 ? 
            ((token.devBuy / 1000000000) * 100).toFixed(2) : null;
        
        // Social links (always show, but with 20% opacity if not available)
        const hasTwitter = token.twitter && token.twitter.trim().length > 0;
        const hasWebsite = token.website && token.website.trim().length > 0;
        const hasTelegram = token.telegram && token.telegram.trim().length > 0;
        
        // Calculate volume
        const totalVolumeSOL = (token.buyVolume || 0) + (token.sellVolume || 0);
        const totalVolumeUSD = totalVolumeSOL * this.solanaPriceUSD;
        
        // Calculate marketcap
        const marketCapUSD = token.marketCapUSD || (token.value || 0) * this.solanaPriceUSD;
        const marketCapFormatted = marketCapUSD ? `$${marketCapUSD.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}` : '$0';
        
        return `
            <div class="token-card" data-mint="${token.mint}">
                <div class="token-social-links">
                    <a href="${hasTwitter ? token.twitter : '#'}" 
                       target="_blank" 
                       class="social-link twitter ${!hasTwitter ? 'disabled' : ''}" 
                       onclick="event.stopPropagation(); ${!hasTwitter ? 'return false;' : ''}">🐦</a>
                    <a href="${hasWebsite ? token.website : '#'}" 
                       target="_blank" 
                       class="social-link website ${!hasWebsite ? 'disabled' : ''}" 
                       onclick="event.stopPropagation(); ${!hasWebsite ? 'return false;' : ''}">🌐</a>
                    <a href="${hasTelegram ? token.telegram : '#'}" 
                       target="_blank" 
                       class="social-link telegram ${!hasTelegram ? 'disabled' : ''}" 
                       onclick="event.stopPropagation(); ${!hasTelegram ? 'return false;' : ''}">💬</a>
                </div>
                <div class="token-main-content">
                    <div class="token-header-row">
                        <div class="token-image-wrapper">
                            ${imageUrl ? 
                                `<img src="" data-src="${imageUrl}" alt="${token.name || ''}" style="display: none; visibility: hidden;">
                                 <div class="token-image-placeholder" style="background: ${colors[colorIndex]};">${symbolText}</div>` :
                                `<div class="token-image-placeholder" style="background: ${colors[colorIndex]};">${symbolText}</div>`
                            }
                        </div>
                        <div class="token-name-section">
                            <div class="token-name-large">${this.escapeHtml(token.name || 'Unknown')}</div>
                            <div class="token-symbol-large">${this.escapeHtml(token.symbol || 'N/A')}</div>
                        </div>
                        <div class="token-marketcap">${marketCapFormatted}</div>
                    </div>
                    <div class="token-metrics-row">
                        ${devBuyPercent ? `<div class="token-metric">👤 ${devBuyPercent}%</div>` : ''}
                        ${token.totalBuys !== undefined || token.totalSells !== undefined ? `<div class="token-metric">📊 ${token.totalBuys || 0} / ${token.totalSells || 0}</div>` : ''}
                        ${token.buyVolume !== undefined || token.sellVolume !== undefined ? `<div class="token-metric">💹 ${this.formatUSD(totalVolumeUSD)}</div>` : ''}
                    </div>
                </div>
                <button class="token-delete-btn" onclick="event.stopPropagation(); app.deleteMatchedToken('${token.mint}');" title="Delete token">
                    ×
                </button>
            </div>
        `;
    }

    updateMatchedToken(tokenData) {
        // Update the token data in matchedTokens map
        const existingToken = this.matchedTokens.get(tokenData.mint);
        if (existingToken) {
            // Merge new data while preserving alert info and tracking data
            const updatedToken = {
                ...existingToken,
                ...tokenData,
                // Preserve alert-specific data
                triggeredAt: existingToken.triggeredAt,
                alertId: existingToken.alertId,
                // Preserve tracking data for pulse animations
                _lastBuys: existingToken._lastBuys !== undefined ? existingToken._lastBuys : (existingToken.totalBuys || 0),
                _lastSells: existingToken._lastSells !== undefined ? existingToken._lastSells : (existingToken.totalSells || 0),
                // Preserve allTimeHigh if not in update
                allTimeHigh: tokenData.allTimeHigh || existingToken.allTimeHigh || tokenData.value || tokenData.marketCapSol || 0
            };
            
            // Update the map
            this.matchedTokens.set(tokenData.mint, updatedToken);
            
            // Update the card in place without full re-render
            this.updateMatchedTokenCard(tokenData.mint);
        }
    }
    
    updateMatchedTokenCard(mint) {
        const token = this.matchedTokens.get(mint);
        if (!token) return;
        
        const card = this.matchedTokensContainer.querySelector(`.token-card[data-mint="${mint}"]`);
        if (!card) return;
        
        // Update marketcap
        const marketCapUSD = token.marketCapUSD || (token.marketCapSol || token.value || 0) * this.solanaPriceUSD;
        const marketCapFormatted = marketCapUSD ? `$${marketCapUSD.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}` : '$0';
        const marketCapEl = card.querySelector('.token-marketcap');
        if (marketCapEl) {
            marketCapEl.textContent = marketCapFormatted;
        }
        
        // Update metrics row
        const metricsRow = card.querySelector('.token-metrics-row');
        if (metricsRow) {
            const metrics = [];
            
            // Dev Buy %
            const devBuyPercent = token.devBuy && token.devBuy > 0 ? 
                ((token.devBuy / 1000000000) * 100).toFixed(2) : null;
            if (devBuyPercent) {
                metrics.push(`👤 ${devBuyPercent}%`);
            }
            
            // Buys / Sells
            if (token.totalBuys !== undefined || token.totalSells !== undefined) {
                metrics.push(`📊 ${token.totalBuys || 0} / ${token.totalSells || 0}`);
            }
            
            // Volume
            if (token.buyVolume !== undefined || token.sellVolume !== undefined) {
                const totalVolumeSOL = (token.buyVolume || 0) + (token.sellVolume || 0);
                const totalVolumeUSD = totalVolumeSOL * this.solanaPriceUSD;
                metrics.push(`💹 ${this.formatUSD(totalVolumeUSD)}`);
            }
            
            // Update metrics row HTML
            metricsRow.innerHTML = metrics.map(metric => 
                `<div class="token-metric">${metric}</div>`
            ).join('');
        }
        
        // Update social links if they changed
        const hasTwitter = token.twitter && token.twitter.trim().length > 0;
        const hasWebsite = token.website && token.website.trim().length > 0;
        const hasTelegram = token.telegram && token.telegram.trim().length > 0;
        
        const twitterLink = card.querySelector('.social-link.twitter');
        if (twitterLink) {
            if (hasTwitter) {
                twitterLink.href = token.twitter;
                twitterLink.classList.remove('disabled');
                twitterLink.setAttribute('onclick', 'event.stopPropagation();');
            } else {
                twitterLink.href = '#';
                twitterLink.classList.add('disabled');
                twitterLink.setAttribute('onclick', 'event.stopPropagation(); return false;');
            }
        }
        
        const websiteLink = card.querySelector('.social-link.website');
        if (websiteLink) {
            if (hasWebsite) {
                websiteLink.href = token.website;
                websiteLink.classList.remove('disabled');
                websiteLink.setAttribute('onclick', 'event.stopPropagation();');
            } else {
                websiteLink.href = '#';
                websiteLink.classList.add('disabled');
                websiteLink.setAttribute('onclick', 'event.stopPropagation(); return false;');
            }
        }
        
        const telegramLink = card.querySelector('.social-link.telegram');
        if (telegramLink) {
            if (hasTelegram) {
                telegramLink.href = token.telegram;
                telegramLink.classList.remove('disabled');
                telegramLink.setAttribute('onclick', 'event.stopPropagation();');
            } else {
                telegramLink.href = '#';
                telegramLink.classList.add('disabled');
                telegramLink.setAttribute('onclick', 'event.stopPropagation(); return false;');
            }
        }
        
        // Add pulse animation for new buys/sells if detected
        const previousBuys = token._lastBuys || 0;
        const previousSells = token._lastSells || 0;
        const newBuys = (token.totalBuys || 0) - previousBuys;
        const newSells = (token.totalSells || 0) - previousSells;
        
        if (newBuys > 0) {
            card.classList.add('pulse-buy');
            setTimeout(() => card.classList.remove('pulse-buy'), 1000);
        }
        if (newSells > 0) {
            card.classList.add('pulse-sell');
            setTimeout(() => card.classList.remove('pulse-sell'), 1000);
        }
        
        // Store current values for next comparison (update in the map)
        const updatedToken = this.matchedTokens.get(mint);
        if (updatedToken) {
            updatedToken._lastBuys = token.totalBuys || 0;
            updatedToken._lastSells = token.totalSells || 0;
        }
        
        // Add gold glow if token is complete
        if (token.complete) {
            card.classList.add('token-complete');
        } else {
            card.classList.remove('token-complete');
        }
    }
    
    updateTokenCardValues(card, token) {
        // This method is kept for backwards compatibility but may not be used for matched tokens
        // Update Dev Buy %
        const devBuyPercent = token.devBuy && token.devBuy > 0 ? 
            ((token.devBuy / 1000000000) * 100).toFixed(2) : null;
        if (devBuyPercent) {
            const devBuyStat = Array.from(card.querySelectorAll('.token-stat')).find(stat => {
                const label = stat.querySelector('.token-stat-label');
                return label && label.textContent === 'Dev Buy';
            });
            if (devBuyStat) {
                const value = devBuyStat.querySelector('.token-stat-value');
                if (value) {
                    value.textContent = devBuyPercent + '%';
                }
            }
        }

        // Update Buys / Sells
        if (token.totalBuys !== undefined || token.totalSells !== undefined) {
            const buysSellsStat = Array.from(card.querySelectorAll('.token-stat')).find(stat => {
                const label = stat.querySelector('.token-stat-label');
                return label && label.textContent === 'Buys / Sells';
            });
            if (buysSellsStat) {
                const value = buysSellsStat.querySelector('.token-stat-value');
                if (value) {
                    value.textContent = `${token.totalBuys || 0} / ${token.totalSells || 0}`;
                }
            }
        }

        // Update Volume
        if (token.buyVolume !== undefined || token.sellVolume !== undefined) {
            const totalVolumeSOL = (token.buyVolume || 0) + (token.sellVolume || 0);
            const totalVolumeUSD = totalVolumeSOL * this.solanaPriceUSD;
            const volumeStat = Array.from(card.querySelectorAll('.token-stat')).find(stat => {
                const label = stat.querySelector('.token-stat-label');
                return label && label.textContent === 'Volume';
            });
            if (volumeStat) {
                const value = volumeStat.querySelector('.token-stat-value');
                if (value) {
                    value.textContent = this.formatUSD(totalVolumeUSD);
                }
            }
        }
    }

    extractTwitterUsername(twitterUrl) {
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

    async fetchDeveloperTokens(address) {
        try {
            const response = await fetch(`/api/developer-tokens/${address}`);
            
            if (!response.ok) {
                return null;
            }
            
            const data = await response.json();
            
            // Handle different response structures
            if (Array.isArray(data)) {
                return data;
            } else if (data && Array.isArray(data.data)) {
                return data.data;
            } else if (data && Array.isArray(data.coins)) {
                return data.coins;
            } else if (data && Array.isArray(data.items)) {
                return data.items;
            }
            
            return null;
        } catch (error) {
            console.error(`Error fetching developer tokens for ${address}:`, error.message);
            return null;
        }
    }

    async checkAlert(alert, token) {
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
                if (!token.value || !this.solanaPriceUSD || alert.threshold === undefined || alert.threshold === null) {
                    return false;
                }
                const marketCapUSD = token.value * this.solanaPriceUSD;
                return marketCapUSD >= alert.threshold;
            
            case 'deployer-bonded':
                // Check if the deployer has bonded percentage of their tokens
                if (!token.deployer) {
                    return false;
                }
                try {
                    // Check cache first - use longer cache time (5 minutes) to prevent spam
                    let created = this.developerTokensCache.get(token.deployer);
                    if (!created) {
                        // Check if there's a pending request for this deployer to avoid duplicate requests
                        const cacheKey = `pending_${token.deployer}`;
                        if (this.developerTokensCache.has(cacheKey)) {
                            // Wait a bit and check cache again
                            await new Promise(resolve => setTimeout(resolve, 500));
                            created = this.developerTokensCache.get(token.deployer);
                            if (created) {
                                return this.calculateBondedPercentage(created, token, alert);
                            }
                            return false;
                        }
                        
                        // Mark as pending
                        this.developerTokensCache.set(cacheKey, true);
                        
                        try {
                            created = await this.fetchDeveloperTokens(token.deployer);
                            // Cache for 5 minutes to avoid spam
                            if (created) {
                                this.developerTokensCache.set(token.deployer, created);
                                setTimeout(() => {
                                    this.developerTokensCache.delete(token.deployer);
                                }, 300000); // 5 minutes
                            }
                        } finally {
                            // Remove pending flag
                            this.developerTokensCache.delete(cacheKey);
                        }
                    }
                    
                    return this.calculateBondedPercentage(created, token, alert);
                } catch (error) {
                    console.error(`Error checking deployer-bonded alert for ${alert.id}:`, error.message);
                    return false;
                }
            
            case 'twitter-handle':
                if (!token.twitter) return false;
                const twitterUsername = this.extractTwitterUsername(token.twitter);
                if (!twitterUsername) return false;
                return twitterUsername === alert.value.toLowerCase();
            
            case 'website-contains':
                if (!token.website) return false;
                return token.website.toLowerCase().includes(alert.value.toLowerCase());
            
            default:
                return false;
        }
    }
    
    calculateBondedPercentage(created, token, alert) {
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
    }

    async checkAlertsForToken(token, isNewToken = false) {
        if (!token.mint) return;
        
        let alertTriggered = false;
        let matchedAlertId = null;
        
        for (const alert of this.alerts) {
            try {
                // Skip deployer alerts on trade updates (only check on new tokens)
                // This prevents spam API requests on every trade
                if (!isNewToken && (alert.type === 'deployer-bonded' || alert.type === 'deployer-marketcap')) {
                    // Skip deployer alerts entirely on trade updates
                    continue;
                }
                
                const shouldTrigger = await this.checkAlert(alert, token);
                if (shouldTrigger) {
                    const alertKey = `${token.mint}-${alert.id}`;
                    const isNewTrigger = !this.triggeredAlerts.has(alertKey);
                    
                    alertTriggered = true;
                    matchedAlertId = alert.id;
                    
                    // Mark this alert as triggered for this token
                    this.triggeredAlerts.add(alertKey);
                    
                    // Only play sound and log if this is the first time this alert triggers for this token
                    if (isNewTrigger) {
                        console.log(`🚨 ALERT TRIGGERED: ${this.getAlertDescription(alert)} - Token: ${token.name} (${token.symbol})`);
                        // Play alert sound
                        this.playAlertSound();
                    }
                }
            } catch (error) {
                console.error(`Error checking alert ${alert.id}:`, error.message);
            }
        }
        
        // Update matched token if it exists (even if no new alert triggered)
        // This ensures buys/sells data is always up to date
        if (this.matchedTokens.has(token.mint)) {
            // Token already exists, update it in place (real-time update)
            this.updateMatchedToken(token);
        } else if (alertTriggered) {
            // Add new matched token
            this.matchedTokens.set(token.mint, {
                ...token,
                triggeredAt: Date.now(),
                alertId: matchedAlertId,
                // Initialize tracking for pulse animations
                _lastBuys: token.totalBuys || 0,
                _lastSells: token.totalSells || 0
            });
            this.renderMatchedTokens();
        }
    }
    
    // DM Alerts Modal Methods
    openDmAlertsModal() {
        this.dmAlertsModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        
        // Reset to first slide (choose action) if not logged in
        if (!this.currentUser) {
            this.showDmAlertsSlide(0);
            // Hide login form and profile actions
            const loginForm = document.getElementById('loginForm');
            const profileActions = document.getElementById('profileActions');
            const profileCreatedMessage = document.getElementById('profileCreatedMessage');
            if (loginForm) loginForm.style.display = 'none';
            if (profileActions) profileActions.style.display = 'none';
            if (profileCreatedMessage) profileCreatedMessage.style.display = 'none';
        } else {
            // Show profile actions if logged in (slide 3)
            this.showDmAlertsSlide(3);
            const loginForm = document.getElementById('loginForm');
            const profileActions = document.getElementById('profileActions');
            const profileCreatedMessage = document.getElementById('profileCreatedMessage');
            if (loginForm) loginForm.style.display = 'none';
            if (profileActions) profileActions.style.display = 'block';
            if (profileCreatedMessage) profileCreatedMessage.style.display = 'none';
            const loggedInUsername = document.getElementById('loggedInUsername');
            if (loggedInUsername) loggedInUsername.textContent = this.currentUser.username;
        }
    }
    
    closeDmAlertsModal() {
        this.dmAlertsModal.classList.remove('active');
        document.body.style.overflow = '';
    }
    
    showDmAlertsSlide(slideIndex) {
        const slides = document.querySelectorAll('.dm-alerts-slide');
        slides.forEach((slide, index) => {
            if (index === slideIndex) {
                slide.classList.add('active');
            } else {
                slide.classList.remove('active');
            }
        });
    }
    
    async checkUsername() {
        const username = this.usernameInput?.value.trim();
        const errorDiv = document.getElementById('usernameError');
        
        if (!username) {
            if (errorDiv) {
                errorDiv.textContent = 'Please enter a username';
                errorDiv.style.display = 'block';
            }
            return;
        }
        
        // Validate format
        if (username.length > 16 || !/^[a-zA-Z0-9]+$/.test(username)) {
            if (errorDiv) {
                errorDiv.textContent = 'Username must be up to 16 characters and contain only letters and numbers';
                errorDiv.style.display = 'block';
            }
            return;
        }
        
        if (errorDiv) errorDiv.style.display = 'none';
        
        try {
            const response = await fetch('/api/users/check-username', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            
            const data = await response.json();
            
            if (response.ok && data.available) {
                // Store username for next slide
                this.pendingUsername = username;
                const confirmedUsername = document.getElementById('confirmedUsername');
                if (confirmedUsername) confirmedUsername.textContent = username;
                this.showDmAlertsSlide(2); // Go to password entry slide
            } else {
                if (errorDiv) {
                    errorDiv.textContent = data.error || 'Username is not available';
                    errorDiv.style.display = 'block';
                }
            }
        } catch (error) {
            console.error('Error checking username:', error);
            if (errorDiv) {
                errorDiv.textContent = 'Error checking username. Please try again.';
                errorDiv.style.display = 'block';
            }
        }
    }
    
    async createProfile() {
        const username = this.pendingUsername;
        const password = this.passwordInput?.value;
        const errorDiv = document.getElementById('passwordError');
        
        if (!password || password.length < 4) {
            if (errorDiv) {
                errorDiv.textContent = 'Password must be at least 4 characters';
                errorDiv.style.display = 'block';
            }
            return;
        }
        
        if (errorDiv) errorDiv.style.display = 'none';
        
        try {
            const response = await fetch('/api/users/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            
            const data = await response.json();
            
            if (response.ok && data.success) {
                // Store user session
                this.currentUser = { username, password };
                // Save session to localStorage
                this.saveUserSessionToStorage();
                
                // Show success message and profile actions
                const profileCreatedMessage = document.getElementById('profileCreatedMessage');
                const loginForm = document.getElementById('loginForm');
                const profileActions = document.getElementById('profileActions');
                const loggedInUsername = document.getElementById('loggedInUsername');
                
                if (profileCreatedMessage) profileCreatedMessage.style.display = 'block';
                if (loginForm) loginForm.style.display = 'none';
                if (profileActions) profileActions.style.display = 'block';
                if (loggedInUsername) loggedInUsername.textContent = username;
                
                this.showDmAlertsSlide(3); // Go to profile management slide
                
                // Update login button text
                this.updateLoginButtonText();
                
                // Check Telegram status and update button
                this.checkTelegramStatus();
                
                // Load alerts from server
                this.loadAlertsFromServer();
                
                // Clear form
                if (this.usernameInput) this.usernameInput.value = '';
                if (this.passwordInput) this.passwordInput.value = '';
                this.pendingUsername = null;
            } else {
                if (errorDiv) {
                    errorDiv.textContent = data.error || 'Failed to create profile';
                    errorDiv.style.display = 'block';
                }
            }
        } catch (error) {
            console.error('Error creating profile:', error);
            if (errorDiv) {
                errorDiv.textContent = 'Error creating profile. Please try again.';
                errorDiv.style.display = 'block';
            }
        }
    }
    
    async loginUser() {
        const username = this.loginUsername?.value.trim();
        const password = this.loginPassword?.value;
        const errorDiv = document.getElementById('loginError');
        
        if (!username || !password) {
            if (errorDiv) {
                errorDiv.textContent = 'Please enter username and password';
                errorDiv.style.display = 'block';
            }
            return;
        }
        
        if (errorDiv) errorDiv.style.display = 'none';
        
        try {
            const response = await fetch('/api/users/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            
            const data = await response.json();
            
            if (response.ok && data.success) {
                // Store user session
                this.currentUser = { username, password };
                // Save session to localStorage
                this.saveUserSessionToStorage();
                
                // Show profile actions on slide 3
                this.showDmAlertsSlide(3);
                const loginForm = document.getElementById('loginForm');
                const profileActions = document.getElementById('profileActions');
                const loggedInUsername = document.getElementById('loggedInUsername');
                const profileCreatedMessage = document.getElementById('profileCreatedMessage');
                
                if (loginForm) loginForm.style.display = 'none';
                if (profileActions) profileActions.style.display = 'block';
                if (loggedInUsername) loggedInUsername.textContent = username;
                if (profileCreatedMessage) profileCreatedMessage.style.display = 'none';
                
                // Update login button text
                this.updateLoginButtonText();
                
                // Check Telegram status and update button
                this.checkTelegramStatus();
                
                // Load alerts from server
                this.loadAlertsFromServer();
                
                // Clear login form
                if (this.loginUsername) this.loginUsername.value = '';
                if (this.loginPassword) this.loginPassword.value = '';
            } else {
                if (errorDiv) {
                    errorDiv.textContent = data.error || 'Invalid username or password';
                    errorDiv.style.display = 'block';
                }
            }
        } catch (error) {
            console.error('Error logging in:', error);
            if (errorDiv) {
                errorDiv.textContent = 'Error logging in. Please try again.';
                errorDiv.style.display = 'block';
            }
        }
    }
    
    linkTelegram() {
        if (!this.currentUser) {
            this.showToast('Please log in first', 'warning');
            return;
        }
        
        // Open Telegram with /start command and username parameter
        const telegramUrl = `https://t.me/PFKit_bot?start=${encodeURIComponent(this.currentUser.username.toLowerCase())}`;
        window.open(telegramUrl, '_blank');
        
        // Show info message
        this.showToast('Opening Telegram... Click "Start" in the bot to link your account.', 'info');
        
        // Poll for Telegram link status every 2 seconds for up to 30 seconds
        let pollCount = 0;
        const maxPolls = 15; // 15 polls * 2 seconds = 30 seconds
        
        const pollInterval = setInterval(() => {
            pollCount++;
            this.checkTelegramStatus().then(linked => {
                if (linked) {
                    clearInterval(pollInterval);
                } else if (pollCount >= maxPolls) {
                    clearInterval(pollInterval);
                    this.showToast('Link timeout. Please try again if you completed the linking process.', 'warning');
                }
            });
        }, 2000);
    }
    
    async checkTelegramStatus() {
        if (!this.currentUser) return false;
        
        try {
            const response = await fetch('/api/users/check-telegram', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.currentUser.username,
                    password: this.currentUser.password
                })
            });
            
            const data = await response.json();
            
            if (response.ok && data.success) {
                const wasLinked = this.linkTelegramBtn?.textContent.includes('Linked');
                this.updateTelegramButtonState(data.telegramLinked);
                
                // Only show success toast if it just became linked
                if (data.telegramLinked && !wasLinked) {
                    this.showToast('Telegram successfully linked!', 'success');
                }
                
                return data.telegramLinked;
            }
        } catch (error) {
            console.error('Error checking Telegram status:', error);
        }
        
        return false;
    }
    
    updateLoginButtonText() {
        if (!this.dmAlertsBtn) return;
        
        if (this.currentUser) {
            // Show username when logged in
            this.dmAlertsBtn.innerHTML = `
                <span class="btn-icon">👤</span>
                ${this.escapeHtml(this.currentUser.username)}
            `;
        } else {
            // Show "Login" when not logged in
            this.dmAlertsBtn.innerHTML = `
                <span class="btn-icon">🔑</span>
                Login
            `;
        }
    }

    updateTelegramButtonState(linked) {
        if (!this.linkTelegramBtn) return;
        
        if (linked) {
            this.linkTelegramBtn.innerHTML = '<span>Telegram Linked ✓</span>';
            this.linkTelegramBtn.disabled = true;
            this.linkTelegramBtn.style.opacity = '1';
            this.linkTelegramBtn.style.cursor = 'default';
            this.linkTelegramBtn.classList.add('btn-success');
        } else {
            this.linkTelegramBtn.innerHTML = '<span>Link to Telegram</span>';
            this.linkTelegramBtn.disabled = false;
            this.linkTelegramBtn.style.opacity = '1';
            this.linkTelegramBtn.style.cursor = 'pointer';
            this.linkTelegramBtn.classList.remove('btn-success');
        }
        
    }
    
    logoutUser() {
        this.currentUser = null;
        // Clear session from localStorage
        this.clearUserSessionFromStorage();
        
        // Update login button text
        this.updateLoginButtonText();
        
        // Clear alerts when logging out (alerts are tied to user profile)
        this.alerts = [];
        this.renderAlerts();
        
        // Reset to slide 0 (choose action)
        this.showDmAlertsSlide(0);
        const loginForm = document.getElementById('loginForm');
        const profileActions = document.getElementById('profileActions');
        const profileCreatedMessage = document.getElementById('profileCreatedMessage');
        
        if (loginForm) loginForm.style.display = 'none';
        if (profileActions) profileActions.style.display = 'none';
        if (profileCreatedMessage) profileCreatedMessage.style.display = 'none';
        
        // Reset Telegram button
        if (this.linkTelegramBtn) {
            this.linkTelegramBtn.textContent = 'Link to Telegram';
            this.linkTelegramBtn.disabled = true;
            this.linkTelegramBtn.style.opacity = '0.6';
            this.linkTelegramBtn.style.cursor = 'not-allowed';
            this.linkTelegramBtn.classList.remove('btn-success');
        }
        
        // Clear login form
        if (this.loginUsername) this.loginUsername.value = '';
        if (this.loginPassword) this.loginPassword.value = '';
    }
    
    showToast(message, type = 'success') {
        // Remove existing toast if any
        const existingToast = document.querySelector('.toast-notification');
        if (existingToast) {
            existingToast.remove();
        }
        
        // Create toast element
        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        
        // Add icon based on type
        let icon = '✓';
        if (type === 'error') {
            icon = '✗';
        } else if (type === 'warning') {
            icon = '⚠';
        } else if (type === 'info') {
            icon = 'ℹ';
        }
        
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-icon">${icon}</span>
                <span class="toast-message">${this.escapeHtml(message)}</span>
            </div>
        `;
        
        document.body.appendChild(toast);
        
        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
        
        // Auto remove after 3 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.remove();
                }
            }, 300);
        }, 3000);
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app when DOM is ready
let app;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        app = new AlertApp();
        // Check if we should open the modal based on URL hash
        if (window.location.hash === '#login' || window.location.hash === '#profile') {
            // Small delay to ensure modal is ready
            setTimeout(() => {
                if (app && app.openDmAlertsModal) {
                    app.openDmAlertsModal();
                }
            }, 100);
        }
    });
} else {
    app = new AlertApp();
    // Check if we should open the modal based on URL hash
    if (window.location.hash === '#login' || window.location.hash === '#profile') {
        // Small delay to ensure modal is ready
        setTimeout(() => {
            if (app && app.openDmAlertsModal) {
                app.openDmAlertsModal();
            }
        }, 100);
    }
}

// Make functions globally available
window.app = app;


// Canvas Animations (similar to alerts page)
class CanvasAnimations {
    constructor() {
        this.backgroundCanvas = document.getElementById('backgroundCanvas');
        this.statusCanvas = document.getElementById('statusCanvas');

        if (!this.backgroundCanvas || !this.statusCanvas) {
            console.error('Required canvas elements not found');
            return;
        }

        this.bgCtx = this.backgroundCanvas.getContext('2d');
        this.statusCtx = this.statusCanvas.getContext('2d');

        this.setupBackground();
        this.setupStatus();
    }

    setupBackground() {
        const resize = () => {
            this.backgroundCanvas.width = window.innerWidth;
            this.backgroundCanvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);
        this.animateBackground();
    }

    animateBackground() {
        const ctx = this.bgCtx;
        const width = this.backgroundCanvas.width;
        const height = this.backgroundCanvas.height;
        const time = Date.now() * 0.001;

        // Fill with dark background
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        // Add subtle animated gradient
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, 'rgba(96, 165, 250, 0.05)');
        gradient.addColorStop(1, 'rgba(74, 222, 128, 0.05)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        requestAnimationFrame(() => this.animateBackground());
    }

    setupStatus() {
        this.updateStatus(false);
    }

    updateStatus(connected) {
        const ctx = this.statusCtx;
        ctx.clearRect(0, 0, 12, 12);
        
        if (connected) {
            ctx.fillStyle = '#4ade80';
            
            // Pulse animation
            const pulse = (1 + Math.sin(Date.now() * 0.005)) * 0.5;
            ctx.globalAlpha = 0.3 + pulse * 0.2;
            ctx.beginPath();
            ctx.arc(6, 6, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        } else {
            ctx.fillStyle = '#f87171';
            ctx.beginPath();
            ctx.arc(6, 6, 6, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// Main Scout App
class ScoutApp {
    constructor() {
        this.canvasAnimations = new CanvasAnimations();
        this.tokens = new Map(); // Store tokens by mint
        this.solanaPriceUSD = 0;
        this.currentSort = 'recent';
        this.loadedImages = new Set(); // Track which image URLs have been successfully loaded
        this.audioContext = null; // For playing completion sound
        this.dexScreenerCheckInterval = null; // Interval for checking DexScreener profiles
        this.dexPaymentCheckInterval = null; // Interval for checking DexScreener payment status
        this.dexPaymentStatuses = new Map(); // Track payment statuses already triggered (mint -> Set of statuses)
        this.tokenEvents = []; // Store token events for ticker
        this.tokenEventsTickerContainer = null; // Token events ticker container
        this.tokenEventsTicker = null; // Token events ticker element
        this.topLiveStreamSlot = null; // Top live stream slot container
        this.topLiveStreamContent = null; // Top live stream content element
        this.currentTopStream = null; // Current top stream data
        this.previousTopStreamMint = null; // Track previous top stream mint to detect changes
        this.ogEventCache = new Map(); // Cache for OG event detection (twitter -> Set of mints)
        this.processedCTOs = new Set(); // Track processed CTO events
        this.processedBoosts = new Set(); // Track processed Boost events
        this.processedAds = new Set(); // Track processed Ads events
        this.eventTokenUpdateInterval = null; // Interval for updating event token data
        this.eventTokenPreviousMarketcaps = new Map(); // Track previous marketcaps for color changes (mint -> marketcap)
        this.isHoveringToken = false; // Track if user is hovering over any token
        this.renderPending = false; // Track if a render is pending
        this.volumeResortInterval = null; // Interval for auto-resorting volume sorts
        this.resortCountdown = 0; // Countdown for next resort (in seconds)
        this.allowVolumeResort = false; // Flag to control when volume sorts can resort
        this.settings = {
            tokenClickOption: 'pumpfun', // Default: Pump.Fun
            alertVolume: 50, // Default: 50%
            theme: 'pump', // Default: pump theme
            sortType: 'recent' // Default: Most Recent
        };
        
        this.currentUser = null; // Store current user session
        
        this.initElements();
        this.loadSettingsFromStorage();
        // Load user session from localStorage
        this.loadUserSessionFromStorage();
        // Apply saved sort type after loading settings
        if (this.settings.sortType) {
            this.currentSort = this.settings.sortType;
            this.setSortType(this.currentSort);
        }
        this.initAlertSound();
        this.initSocket();
        this.initEventListeners();
        this.startDexScreenerChecks();
        this.startDexPaymentChecks();
        this.startTokenEventsUpdates(); // Start token events updates
        this.startEventTokenUpdates(); // Start updating event tokens every 5 seconds
        this.startVolumeAutoResort(); // Start auto-resort if volume sort is selected
    }

    initElements() {
        this.statusEl = document.getElementById('status');
        this.statusText = this.statusEl.querySelector('.status-text');
        this.tokensContainer = document.getElementById('tokensContainer');
        this.tokenCount = document.getElementById('tokenCount');
        this.sortBtn = document.getElementById('sortBtn');
        this.sortModal = document.getElementById('sortModal');
        this.closeSortModalBtn = document.getElementById('closeSortModalBtn');
        this.cancelSortBtn = document.getElementById('cancelSortBtn');
        this.sortOptionButtons = document.querySelectorAll('.modal-action-btn[data-sort]');
        this.settingsBtn = document.getElementById('settingsBtn');
        this.settingsModal = document.getElementById('settingsModal');
        this.closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
        this.cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
        this.saveSettingsBtn = document.getElementById('saveSettingsBtn');
        this.settingsOptionButtons = document.querySelectorAll('.settings-option-btn:not(.theme-btn)');
        this.themeButtons = document.querySelectorAll('.theme-btn');
        this.alertVolumeSlider = document.getElementById('alertVolume');
        this.alertVolumeValue = document.getElementById('alertVolumeValue');
        this.tokenEventsTickerContainer = document.getElementById('tokenEventsTickerContainer');
        this.tokenEventsTicker = document.getElementById('tokenEventsTicker');
        this.tokenEventsTickerWrapper = this.tokenEventsTickerContainer ? this.tokenEventsTickerContainer.querySelector('.token-events-ticker-wrapper') : null;
        this.topLiveStreamSlot = document.getElementById('topLiveStreamSlot');
        this.topLiveStreamContent = document.getElementById('topLiveStreamContent');
        this.resortIndicator = document.getElementById('resortIndicator');
        
        // Initialize ticker with waiting message if no events yet
        if (this.tokenEventsTicker && this.tokenEvents.length === 0) {
            this.tokenEventsTicker.innerHTML = '<div class="token-events-waiting">Waiting for token events...</div>';
        }
        this.helpBtn = document.getElementById('helpBtn');
        this.helpModal = document.getElementById('helpModal');
        this.closeHelpBtn = document.getElementById('closeHelpBtn');
        this.closeHelpBtn2 = document.getElementById('closeHelpBtn2');
        this.loginBtn = document.getElementById('loginBtn');
        
        // DM Alerts modal elements
        this.dmAlertsModal = document.getElementById('dmAlertsModal');
        this.closeDmAlertsBtn = document.getElementById('closeDmAlertsBtn');
        this.usernameInput = document.getElementById('usernameInput');
        this.passwordInput = document.getElementById('passwordInput');
        this.checkUsernameBtn = document.getElementById('checkUsernameBtn');
        this.createProfileOptionBtn = document.getElementById('createProfileOptionBtn');
        this.loginOptionBtn = document.getElementById('loginOptionBtn');
        this.createProfileBtn = document.getElementById('createProfileBtn');
        this.backToUsernameBtn = document.getElementById('backToUsernameBtn');
        this.backToOptionsBtn = document.getElementById('backToOptionsBtn');
        this.backToOptionsFromLoginBtn = document.getElementById('backToOptionsFromLoginBtn');
        this.loginSubmitBtn = document.getElementById('loginSubmitBtn');
        this.loginUsername = document.getElementById('loginUsername');
        this.loginPassword = document.getElementById('loginPassword');
        this.linkTelegramBtn = document.getElementById('linkTelegramBtn');
        this.logoutBtn = document.getElementById('logoutBtn');
        
        this.pendingUsername = null; // Store username during profile creation
    }

    initAlertSound() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (error) {
            console.warn('Web Audio API not supported:', error);
        }
    }

    async playLowTone() {
        // Check if audio is enabled (volume > 0)
        if (this.settings.alertVolume === 0) {
            return;
        }

        // Initialize audio context if not already initialized
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (error) {
                console.warn('Web Audio API not supported:', error);
                return;
            }
        }

        try {
            // Resume audio context if suspended (required by some browsers)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            // Create a low tone (200Hz) oscillator
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.type = 'sine';
            oscillator.frequency.value = 200; // Low frequency tone
            
            // Set volume based on settings (0-1 range, but we use 0-100, so divide by 100)
            const volume = this.settings.alertVolume / 100;
            gainNode.gain.setValueAtTime(volume * 0.3, this.audioContext.currentTime); // 30% of volume setting
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15); // Fade out quickly
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.start(this.audioContext.currentTime);
            oscillator.stop(this.audioContext.currentTime + 0.15); // Short duration
        } catch (error) {
            console.warn('Error playing low tone:', error);
        }
    }

    async playCompletionSound() {
        if (!this.audioContext || this.settings.alertVolume === 0) {
            return;
        }

        try {
            // Resume audio context if suspended (required by some browsers)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            // Uplifting sound: ascending major chord progression
            const oscillator1 = this.audioContext.createOscillator();
            const oscillator2 = this.audioContext.createOscillator();
            const oscillator3 = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator1.connect(gainNode);
            oscillator2.connect(gainNode);
            oscillator3.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            // Use volume from settings (scale 0-100 to 0-0.25)
            const volume = (this.settings.alertVolume || 50) / 100 * 0.25;
            
            // Create a pleasant major chord (C-E-G)
            oscillator1.frequency.setValueAtTime(523.25, this.audioContext.currentTime); // C5
            oscillator2.frequency.setValueAtTime(659.25, this.audioContext.currentTime); // E5
            oscillator3.frequency.setValueAtTime(783.99, this.audioContext.currentTime); // G5
            
            oscillator1.type = 'sine';
            oscillator2.type = 'sine';
            oscillator3.type = 'sine';
            
            // Envelope: fade in and out smoothly
            gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
            gainNode.gain.linearRampToValueAtTime(volume, this.audioContext.currentTime + 0.1);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.5);
            
            // Ascend the chord
            oscillator1.frequency.linearRampToValueAtTime(659.25, this.audioContext.currentTime + 0.3); // E5
            oscillator2.frequency.linearRampToValueAtTime(783.99, this.audioContext.currentTime + 0.3); // G5
            oscillator3.frequency.linearRampToValueAtTime(987.77, this.audioContext.currentTime + 0.3); // B5
            
            oscillator1.start(this.audioContext.currentTime);
            oscillator2.start(this.audioContext.currentTime);
            oscillator3.start(this.audioContext.currentTime);
            
            oscillator1.stop(this.audioContext.currentTime + 0.5);
            oscillator2.stop(this.audioContext.currentTime + 0.5);
            oscillator3.stop(this.audioContext.currentTime + 0.5);
        } catch (error) {
            console.warn('Error playing completion sound:', error);
        }
    }

    initSocket() {
        console.log('[Scout] 🔌 initSocket() called - Creating socket connection...');
        this.socket = io();
        console.log('[Scout] 🔌 Socket.io client created, waiting for connection...');

        this.socket.on('connect', () => {
            console.log('[Scout] ✅ Socket connected, socket.id:', this.socket.id);
            console.log('[Scout] ✅ Socket is ready to receive events');
            this.statusText.textContent = 'Connected';
            this.statusEl.className = 'status-indicator connected';
            this.canvasAnimations.updateStatus(true);
        });

        this.socket.on('disconnect', () => {
            console.log('[Scout] ❌ Socket disconnected');
            this.statusText.textContent = 'Disconnected';
            this.statusEl.className = 'status-indicator disconnected';
            this.canvasAnimations.updateStatus(false);
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('[Scout] ❌ Socket connection error:', error);
        });

        // Get Solana price on connection
        this.socket.on('solana:price', (data) => {
            this.solanaPriceUSD = data.price || 0;
        });

        // Get all tokens from server on connection
        this.socket.on('tokens:all', (tokens) => {
            console.log(`Received ${tokens.length} tokens from server`);
            this.tokens.clear();
            tokens.forEach(token => {
                // Convert uniqueBuyers array back to Set if needed
                if (token.uniqueBuyers && Array.isArray(token.uniqueBuyers)) {
                    token.uniqueBuyers = new Set(token.uniqueBuyers);
                }
                // Initialize hasDexProfile flag
                token.hasDexProfile = false;
                // Initialize allTimeHigh if not present (fallback to current marketcap)
                if (!token.allTimeHigh) {
                    token.allTimeHigh = token.value || token.marketCapSol || 0;
                }
                this.tokens.set(token.mint, token);
            });
            this.renderTokens();
        });

        // Listen for new tokens
        this.socket.on('token:new', (tokenData) => {
            // Convert uniqueBuyers array back to Set if needed
            if (tokenData.uniqueBuyers && Array.isArray(tokenData.uniqueBuyers)) {
                tokenData.uniqueBuyers = new Set(tokenData.uniqueBuyers);
            }
            // Initialize hasDexProfile flag
            tokenData.hasDexProfile = false;
            // Initialize allTimeHigh if not present (fallback to current marketcap)
            if (!tokenData.allTimeHigh) {
                tokenData.allTimeHigh = tokenData.value || tokenData.marketCapSol || 0;
            }
            this.tokens.set(tokenData.mint, tokenData);
            this.renderTokens();
        });

        // Listen for token updates (trades)
        this.socket.on('token:update', (tokenData) => {
            const existingToken = this.tokens.get(tokenData.mint);
            if (existingToken) {
                // Preserve allTimeHigh if not in update (should always be included, but safety check)
                if (!tokenData.allTimeHigh && existingToken.allTimeHigh) {
                    tokenData.allTimeHigh = existingToken.allTimeHigh;
                }
                // Track previous values to detect new trades
                const previousBuys = existingToken.totalBuys || 0;
                const previousSells = existingToken.totalSells || 0;
                const wasComplete = existingToken.complete || false;
                
                // Merge update into existing token
                if (tokenData.uniqueBuyers && Array.isArray(tokenData.uniqueBuyers)) {
                    tokenData.uniqueBuyers = new Set(tokenData.uniqueBuyers);
                }
                Object.assign(existingToken, tokenData);
                
                // Check if token just became complete
                if (tokenData.complete && !wasComplete) {
                    this.playCompletionSound();
                    this.addGoldGlow(tokenData.mint);
                }
                
                // Check for new trades and trigger pulse animations
                const newBuys = (existingToken.totalBuys || 0) - previousBuys;
                const newSells = (existingToken.totalSells || 0) - previousSells;
                
                this.updateTokenCard(tokenData.mint, newBuys > 0, newSells > 0);
            }
        });

        // Listen for token removal
        this.socket.on('token:remove', (data) => {
            if (data.mint) {
                this.deleteToken(data.mint);
            }
        });

        // Listen for token completion (migration)
        this.socket.on('token:complete', (tokenData) => {
            const existingToken = this.tokens.get(tokenData.mint);
            if (existingToken) {
                // Mark as complete
                existingToken.complete = true;
                existingToken.migratedAt = tokenData.migratedAt;
                
                // Play uplifting sound
                this.playCompletionSound();
                
                // Add gold glow to the card
                this.addGoldGlow(tokenData.mint);
            }
            
            // Migration event is now emitted from server-side, no need to handle here
        });

        // Listen for token events (CTO, Boost, Ads, OG, Migration, Dex Payment)
        this.socket.on('token:event', (eventData) => {
            console.log('[Scout] ✅ Received token:event:', eventData?.type || 'unknown type', 'for token:', eventData?.token?.mint?.substring(0, 8) || 'no mint');
            
            if (!eventData) {
                console.error('[Scout] ❌ Event data is null or undefined');
                return;
            }
            
            if (!eventData.type) {
                console.error('[Scout] ❌ Event data missing type field');
                return;
            }
            
            if (!eventData.token) {
                console.error('[Scout] ❌ Event data missing token field');
                return;
            }
            
            this.handleTokenEvent(eventData);
        });
        
        // Listen for top live stream updates
        this.socket.on('top-live-stream:update', (streamData) => {
            console.log('[Scout] 📺 Received top-live-stream:update:', streamData ? `${streamData.name || 'Unknown'} (${streamData.symbol || 'UNKNOWN'})` : 'null (no stream)');
            this.updateTopLiveStream(streamData);
        });
        
        // Also listen for all socket events for debugging
        this.socket.onAny((eventName, ...args) => {
            if (eventName === 'token:event') {
                console.log('[Scout] 🔍 Socket event received:', eventName, 'with', args.length, 'arguments');
            }
        });
    }

    initEventListeners() {
        // Login button - redirect to alerts page for login/profile management
        // When logged in, clicking username will show profile modal on alerts.html
        // Login button - open DM Alerts modal
        if (this.loginBtn) {
            this.loginBtn.addEventListener('click', () => {
                this.openDmAlertsModal();
            });
        }
        
        // Close DM Alerts modal button
        if (this.closeDmAlertsBtn) {
            this.closeDmAlertsBtn.addEventListener('click', () => {
                this.closeDmAlertsModal();
            });
        }
        
        // DM Alerts modal overlay click
        if (this.dmAlertsModal) {
            this.dmAlertsModal.addEventListener('click', (e) => {
                if (e.target === this.dmAlertsModal) {
                    this.closeDmAlertsModal();
                }
            });
        }
        
        // DM Alerts slideshow handlers
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
        if (this.checkUsernameBtn) {
            this.checkUsernameBtn.addEventListener('click', () => this.checkUsername());
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
        if (this.loginSubmitBtn) {
            this.loginSubmitBtn.addEventListener('click', () => this.loginUser());
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
        
        // Sort button - open modal
        this.sortBtn.addEventListener('click', () => {
            this.openSortModal();
        });

        // Close modal buttons
        this.closeSortModalBtn.addEventListener('click', () => {
            this.closeSortModal();
        });

        this.cancelSortBtn.addEventListener('click', () => {
            this.closeSortModal();
        });

        // Close modal when clicking overlay
        this.sortModal.addEventListener('click', (e) => {
            if (e.target === this.sortModal) {
                this.closeSortModal();
            }
        });

        // Sort option buttons
        this.sortOptionButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const sortType = btn.getAttribute('data-sort');
                this.setSortType(sortType);
                this.closeSortModal();
            });
        });

        // Settings button - open modal
        this.settingsBtn.addEventListener('click', () => {
            this.openSettingsModal();
        });

        // Close settings modal buttons
        this.closeSettingsModalBtn.addEventListener('click', () => {
            this.closeSettingsModal();
        });

        this.cancelSettingsBtn.addEventListener('click', () => {
            this.closeSettingsModal();
        });

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

        // Close help modal when clicking overlay
        if (this.helpModal) {
            this.helpModal.addEventListener('click', (e) => {
                if (e.target === this.helpModal) {
                    this.helpModal.classList.remove('active');
                    document.body.style.overflow = '';
                }
            });
        }

        // Close settings modal when clicking overlay
        this.settingsModal.addEventListener('click', (e) => {
            if (e.target === this.settingsModal) {
                this.closeSettingsModal();
            }
        });

        // Settings option buttons (On Token Click)
        this.settingsOptionButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // Remove active from all buttons
                this.settingsOptionButtons.forEach(b => b.classList.remove('active'));
                // Add active to clicked button
                btn.classList.add('active');
            });
        });

        // Theme buttons
        this.themeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.getAttribute('data-theme');
                // Remove active from all theme buttons
                this.themeButtons.forEach(b => b.classList.remove('active'));
                // Add active to clicked button
                btn.classList.add('active');
                // Apply theme immediately for preview
                this.applyTheme(theme);
            });
        });

        // Save settings button
        this.saveSettingsBtn.addEventListener('click', () => {
            this.saveSettings();
        });

        // Volume slider - update display on input, play sound on change (mouse release)
        if (this.alertVolumeSlider) {
            this.alertVolumeSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                if (this.alertVolumeValue) {
                    this.alertVolumeValue.textContent = `${value}%`;
                }
            });

            this.alertVolumeSlider.addEventListener('change', async (e) => {
                const value = parseInt(e.target.value);
                this.settings.alertVolume = value;
                // Play preview sound when slider is released
                await this.playCompletionSound();
            });
        }
    }

    openSortModal() {
        this.sortModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        // Update active state of buttons
        this.updateSortButtons();
    }

    closeSortModal() {
        this.sortModal.classList.remove('active');
        document.body.style.overflow = '';
    }

    updateSortButtons() {
        this.sortOptionButtons.forEach(btn => {
            const sortType = btn.getAttribute('data-sort');
            if (sortType === this.currentSort) {
                btn.classList.add('selected');
            } else {
                btn.classList.remove('selected');
            }
        });
    }

    setSortType(sortType) {
        this.currentSort = sortType;
        this.settings.sortType = sortType; // Save to settings
        this.saveSettingsToStorage(); // Persist to localStorage
        this.updateSortButtons();
        this.startVolumeAutoResort(); // Start or stop auto-resort based on sort type
        
        // For non-auto-resort sorts, render immediately
        // Auto-resort sorts (volume and marketcap) are handled by startVolumeAutoResort which sorts immediately on start
        if (!this.isVolumeSort()) {
            this.renderTokens();
        }
    }

    isVolumeSort() {
        return ['volume', 'volume1m', 'volume5m', 'volume15m', 'marketcap'].includes(this.currentSort);
    }

    startVolumeAutoResort() {
        // Clear existing interval
        if (this.volumeResortInterval) {
            clearInterval(this.volumeResortInterval);
            this.volumeResortInterval = null;
        }
        
        // Hide indicator if not a volume sort
        if (!this.isVolumeSort()) {
            if (this.resortIndicator) {
                this.resortIndicator.style.display = 'none';
            }
            this.resortCountdown = 0;
            return;
        }
        
        // Show indicator
        if (this.resortIndicator) {
            this.resortIndicator.style.display = 'flex';
        }
        
        // Reset countdown to 7 seconds
        this.resortCountdown = 7;
        this.updateResortIndicator();
        
        // Sort immediately when starting auto-resort
        this.allowVolumeResort = true;
        this.renderTokens();
        
        // Start countdown interval (update every second)
        const countdownInterval = setInterval(() => {
            if (!this.isVolumeSort()) {
                clearInterval(countdownInterval);
                return;
            }
            
            this.resortCountdown--;
            this.updateResortIndicator();
            
            if (this.resortCountdown <= 0) {
                // Time to resort (only if not hovering)
                if (!this.isHoveringToken) {
                    this.allowVolumeResort = true; // Allow resorting for this render
                    this.renderTokens();
                } else {
                    // If hovering, wait until hover ends
                    this.renderPending = true;
                }
                
                // Reset countdown
                this.resortCountdown = 7;
            }
        }, 1000);
        
        // Store interval for cleanup
        this.volumeResortInterval = countdownInterval;
    }

    updateResortIndicator() {
        if (!this.resortIndicator || !this.isVolumeSort()) {
            return;
        }
        
        // Update progress bar width (0-100% based on countdown 7-0)
        const progress = ((7 - this.resortCountdown) / 7) * 100;
        const progressBar = this.resortIndicator.querySelector('.resort-progress-bar');
        if (progressBar) {
            progressBar.style.width = `${progress}%`;
        }
    }

    calculateVolumeForMinutes(token, minutes) {
        if (!token.tradesPerMinute || !Array.isArray(token.tradesPerMinute)) {
            return 0;
        }
        
        const now = Date.now();
        const cutoffTime = now - (minutes * 60 * 1000);
        
        let volume = 0;
        for (const trade of token.tradesPerMinute) {
            if (trade.minute >= cutoffTime) {
                // Add both buy and sell volume for this minute
                volume += (trade.buyVolume || 0) + (trade.sellVolume || 0);
            }
        }
        
        return volume;
    }

    sortTokens(tokens) {
        const sorted = Array.from(tokens);
        
        switch (this.currentSort) {
            case 'recent':
                sorted.sort((a, b) => (b.created || 0) - (a.created || 0));
                break;
                
            case 'marketcap':
                sorted.sort((a, b) => {
                    const aUSD = (a.value || 0) * this.solanaPriceUSD;
                    const bUSD = (b.value || 0) * this.solanaPriceUSD;
                    return bUSD - aUSD;
                });
                break;
                
            case 'volume':
                sorted.sort((a, b) => {
                    const aVolume = (a.buyVolume || 0) + (a.sellVolume || 0);
                    const bVolume = (b.buyVolume || 0) + (b.sellVolume || 0);
                    return bVolume - aVolume;
                });
                break;
                
            case 'volume1m':
                sorted.sort((a, b) => {
                    const aVol = this.calculateVolumeForMinutes(a, 1);
                    const bVol = this.calculateVolumeForMinutes(b, 1);
                    return bVol - aVol;
                });
                break;
                
            case 'volume5m':
                sorted.sort((a, b) => {
                    const aVol = this.calculateVolumeForMinutes(a, 5);
                    const bVol = this.calculateVolumeForMinutes(b, 5);
                    return bVol - aVol;
                });
                break;
                
            case 'volume15m':
                sorted.sort((a, b) => {
                    const aVol = this.calculateVolumeForMinutes(a, 15);
                    const bVol = this.calculateVolumeForMinutes(b, 15);
                    return bVol - aVol;
                });
                break;
        }
        
        return sorted;
    }

    formatUSD(value) {
        if (!value || value === 0) return 'N/A';
        if (value < 1) return `$${value.toFixed(4)}`;
        if (value < 1000) return `$${value.toFixed(2)}`;
        if (value < 1000000) return `$${(value / 1000).toFixed(1)}K`;
        return `$${(value / 1000000).toFixed(2)}M`;
    }

    formatSOL(value) {
        if (!value || value === 0) return 'N/A';
        if (value < 1) return `${value.toFixed(4)} SOL`;
        if (value < 1000) return `${value.toFixed(2)} SOL`;
        return `${(value / 1000).toFixed(2)}K SOL`;
    }

    getTokenCardHTML(token) {
        const marketCapUSD = (token.value || 0) * this.solanaPriceUSD;
        const totalVolumeUSD = ((token.buyVolume || 0) + (token.sellVolume || 0)) * this.solanaPriceUSD;
        const volume1m = this.calculateVolumeForMinutes(token, 1) * this.solanaPriceUSD;
        const volume5m = this.calculateVolumeForMinutes(token, 5) * this.solanaPriceUSD;
        const volume15m = this.calculateVolumeForMinutes(token, 15) * this.solanaPriceUSD;
        
        const hasTwitter = token.twitter && token.twitter.trim() !== '';
        const hasWebsite = token.website && token.website.trim() !== '';
        const hasTelegram = token.telegram && token.telegram.trim() !== '';
        
        const imageUrl = token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null;
        const symbolText = (token.symbol || 'UNKNOWN').substring(0, 4).toUpperCase();
        
        // Progress bar calculations (30 SOL to 420 SOL range)
        const MIN_SOL = 30;
        const MAX_SOL = 420;
        const currentMarketCapSol = token.value || 0;
        const athMarketCapSol = token.allTimeHigh || currentMarketCapSol;
        
        // Convert to USD for display
        const minUSD = MIN_SOL * this.solanaPriceUSD;
        const maxUSD = MAX_SOL * this.solanaPriceUSD;
        const currentUSD = currentMarketCapSol * this.solanaPriceUSD;
        const athUSD = athMarketCapSol * this.solanaPriceUSD;
        
        // Calculate progress percentages (0-100%)
        const range = MAX_SOL - MIN_SOL;
        const currentProgress = Math.max(0, Math.min(100, ((currentMarketCapSol - MIN_SOL) / range) * 100));
        const athProgress = Math.max(0, Math.min(100, ((athMarketCapSol - MIN_SOL) / range) * 100));
        
        const completeClass = token.complete ? ' token-complete' : '';
        const hasDexProfile = token.hasDexProfile ? ' has-dex-profile' : '';
        const hasBanner = token.banner_uri && token.banner_uri !== null && token.banner_uri.trim() !== '';
        const bannerHtml = hasBanner ? `<div class="token-banner-hover"><img src="${this.escapeHtml(token.banner_uri)}" alt="${this.escapeHtml(token.name || 'Token')} banner" onerror="this.parentElement.style.display='none';"></div>` : '';
        
        return `
            <div class="dex-token-card${completeClass}${hasDexProfile}${hasBanner ? ' has-banner' : ''}" data-mint="${token.mint}">
                ${bannerHtml}
                <div class="token-image-section-full">
                    <div class="token-image-wrapper-full">
                        <div class="token-image-placeholder-full" style="width: 100%; height: 100%; border-radius: 8px; background: linear-gradient(135deg, #60a5fa, #4ade80); display: flex; align-items: center; justify-content: center; color: white; font-weight: 600; font-size: 0.75rem; position: relative; z-index: 1;">
                        </div>
                        <img src="" data-src="${imageUrl}" style="display: none; visibility: hidden; position: absolute; top: 0; left: 0; z-index: 2;" alt="${token.name || 'Token'}">
                    </div>
                    <div class="token-symbol-below">${symbolText}</div>
                </div>
                <div class="dex-token-content">
                    <div class="dex-token-top">
                        <div class="token-name-large">${token.name || 'Unknown'}</div>
                    </div>
                    <div class="token-progress-section">
                        <div class="token-progress-bar-container">
                            <div class="token-progress-bar" data-field="progress">
                                <div class="token-progress-fill" style="width: ${currentProgress}%;" data-field="progress-fill"></div>
                                ${athProgress > currentProgress ? `<div class="token-progress-ath-marker" style="left: ${athProgress}%;" data-field="ath-marker" title="All Time High: ${this.formatUSD(athUSD)}"></div>` : ''}
                            </div>
                            <div class="token-progress-labels">
                                <span class="token-progress-label-min">${this.formatUSD(minUSD)}</span>
                                <span class="token-progress-label-max">${this.formatUSD(maxUSD)}</span>
                            </div>
                        </div>
                    </div>
                    <div class="dex-token-bottom">
                        <div class="token-stats-mini">
                            <div class="token-stat">
                                <span class="token-stat-label">MC</span>
                                <span class="token-stat-value" data-field="marketcap">${this.formatUSD(marketCapUSD)}</span>
                            </div>
                            <div class="token-stat">
                                <span class="token-stat-label">Vol</span>
                                <span class="token-stat-value" data-field="volume">${this.formatUSD(totalVolumeUSD)}</span>
                            </div>
                            <div class="token-stat">
                                <span class="token-stat-label">Tx</span>
                                <div class="token-stat-tx" data-field="tx">
                                    <span class="tx-buys" data-field="buys">${token.totalBuys || 0}</span>
                                    <span class="tx-separator">/</span>
                                    <span class="tx-sells" data-field="sells">${token.totalSells || 0}</span>
                                </div>
                            </div>
                        </div>
                        <div class="token-social-section">
                            <div class="token-social-links">
                                <a href="${hasTwitter ? token.twitter : '#'}" 
                                   target="_blank" 
                                   rel="noopener noreferrer"
                                   class="social-link twitter ${!hasTwitter ? 'disabled' : ''}" 
                                   data-tooltip="Twitter"
                                   onclick="event.stopPropagation(); ${!hasTwitter ? 'return false;' : ''}">🐦</a>
                                <a href="${hasWebsite ? token.website : '#'}" 
                                   target="_blank" 
                                   rel="noopener noreferrer"
                                   class="social-link website ${!hasWebsite ? 'disabled' : ''}" 
                                   data-tooltip="Website"
                                   onclick="event.stopPropagation(); ${!hasWebsite ? 'return false;' : ''}">🌐</a>
                                <a href="${hasTelegram ? token.telegram : '#'}" 
                                   target="_blank" 
                                   rel="noopener noreferrer"
                                   class="social-link telegram ${!hasTelegram ? 'disabled' : ''}" 
                                   data-tooltip="Telegram"
                                   onclick="event.stopPropagation(); ${!hasTelegram ? 'return false;' : ''}">💬</a>
                            </div>
                            <div class="dev-bonded-info">👑 ${token.devBonded ?? 0} / ${token.devTotal ?? 0}</div>
                        </div>
                    </div>
                </div>
                <button class="dex-token-delete-btn" onclick="event.stopPropagation(); scoutApp.deleteToken('${token.mint}');" title="Remove token">×</button>
            </div>
        `;
    }

    renderTokens() {
        // For volume sorts, only allow resorting when explicitly allowed by timer
        // BUT allow initial render if container is empty or showing empty state
        const isEmpty = this.tokensContainer.querySelector('.empty-state') !== null;
        const hasNoCards = this.tokensContainer.querySelectorAll('.dex-token-card').length === 0;
        
        if (this.isVolumeSort() && !this.allowVolumeResort && !isEmpty && !hasNoCards) {
            // Don't resort, but allow updates to card content without resorting
            // We'll update individual cards without changing their order
            return;
        }
        
        // Skip resorting if user is hovering over a token
        if (this.isHoveringToken) {
            this.renderPending = true;
            return;
        }
        
        this.renderPending = false;
        this.allowVolumeResort = false; // Reset flag after resort
        
        if (this.tokens.size === 0) {
            this.tokensContainer.innerHTML = `
                <div class="empty-state">
                    <canvas id="emptyTokensCanvas" width="80" height="80"></canvas>
                    <p>No tokens loaded yet</p>
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
            this.tokenCount.textContent = '0 tokens';
            return;
        }

        const sortedTokens = this.sortTokens(this.tokens.values());
        // Only show top 30 tokens based on sort method
        const displayTokens = sortedTokens.slice(0, 30);
        this.tokenCount.textContent = `${this.tokens.size} token${this.tokens.size !== 1 ? 's' : ''} (showing ${displayTokens.length})`;

        // Remove empty-state if it exists
        const emptyState = this.tokensContainer.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }

        // Get existing cards to preserve DOM elements
        const existingCards = new Map();
        this.tokensContainer.querySelectorAll('.dex-token-card').forEach(card => {
            const mint = card.getAttribute('data-mint');
            if (mint) {
                existingCards.set(mint, card);
            }
        });

        // Check if order changed or if tokens to display changed
        const existingCardsArray = Array.from(this.tokensContainer.querySelectorAll('.dex-token-card'));
        const orderChanged = existingCardsArray.length !== displayTokens.length || 
            existingCardsArray.some((card, index) => {
                const mint = card.getAttribute('data-mint');
                return displayTokens[index]?.mint !== mint;
            });

        // Check which cards are being added, removed, or moved
        const existingMints = new Set(existingCardsArray.map(card => card.getAttribute('data-mint')));
        const displayMints = new Set(displayTokens.map(token => token.mint));
        const cardsToAdd = displayTokens.filter(token => !existingMints.has(token.mint));
        const cardsToRemove = existingCardsArray.filter(card => {
            const mint = card.getAttribute('data-mint');
            return mint && !displayMints.has(mint);
        });
        const cardsToKeep = displayTokens.filter(token => existingMints.has(token.mint));

        // If order changed, smoothly reorder existing cards
        if (orderChanged) {
            // Check if we can reuse existing cards (smooth reordering)
            const allCardsExist = displayTokens.every(token => existingCards.has(token.mint));
            
            if (allCardsExist && existingCardsArray.length === displayTokens.length) {
                // Smooth reordering using FLIP technique (First, Last, Invert, Play)
                // Collect cards in the desired order
                const orderedCards = displayTokens.map(token => existingCards.get(token.mint)).filter(Boolean);
                
                // Step 1: Get initial positions (First)
                const cardPositions = new Map();
                const containerRect = this.tokensContainer.getBoundingClientRect();
                
                orderedCards.forEach((card) => {
                    const rect = card.getBoundingClientRect();
                    cardPositions.set(card, {
                        x: rect.left - containerRect.left,
                        y: rect.top - containerRect.top
                    });
                });
                
                // Step 2: Reorder DOM (Last) - this will cause browser to recalculate positions
                orderedCards.forEach(card => {
                    this.tokensContainer.appendChild(card);
                });
                
                // Force a reflow to ensure new positions are calculated
                this.tokensContainer.offsetHeight;
                
                // Step 3: Calculate differences and invert (Invert)
                requestAnimationFrame(() => {
                    orderedCards.forEach((card) => {
                        const rect = card.getBoundingClientRect();
                        const newX = rect.left - containerRect.left;
                        const newY = rect.top - containerRect.top;
                        
                        const oldPos = cardPositions.get(card);
                        if (oldPos) {
                            const deltaX = oldPos.x - newX;
                            const deltaY = oldPos.y - newY;
                            
                            // Only animate if there's actual movement
                            if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
                                // Apply transform to move back to old position (invert)
                                card.style.transition = 'none';
                                card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
                                
                                // Step 4: Play animation (Play)
                                requestAnimationFrame(() => {
                                    card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
                                    card.style.transform = 'translate(0, 0)';
                                });
                            }
                        }
                    });
                });
                
                // Remove transition class and reset styles after animation completes
                setTimeout(() => {
                    orderedCards.forEach(card => {
                        card.style.transition = '';
                        card.style.transform = '';
                    });
                }, 350);
            } else {
                // Handle add/remove with smooth animations
                const containerRect = this.tokensContainer.getBoundingClientRect();
                
                // Step 1: Fade out and remove cards that are being removed
                if (cardsToRemove.length > 0) {
                    cardsToRemove.forEach(card => {
                        card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        card.style.opacity = '0';
                        card.style.transform = 'scale(0.9)';
                    });
                    
                    // Remove from DOM after animation
                    setTimeout(() => {
                        cardsToRemove.forEach(card => card.remove());
                    }, 200);
                }
                
                // Step 2: Get positions of cards that will remain (for FLIP animation)
                const cardsToKeepPositions = new Map();
                if (cardsToKeep.length > 0) {
                    cardsToKeep.forEach(token => {
                        const card = existingCards.get(token.mint);
                        if (card) {
                            const rect = card.getBoundingClientRect();
                            cardsToKeepPositions.set(card, {
                                x: rect.left - containerRect.left,
                                y: rect.top - containerRect.top
                            });
                        }
                    });
                }
                
                // Step 3: Create new cards for tokens being added (initially hidden)
                const newCardsHTML = cardsToAdd.map(token => this.getTokenCardHTML(token)).join('');
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = newCardsHTML;
                const newCards = Array.from(tempDiv.children);
                
                // Initially hide new cards
                newCards.forEach(card => {
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.9)';
                    this.tokensContainer.appendChild(card);
                });
                
                // Step 4: Reorder all cards (existing + new) to correct positions
                const allOrderedCards = displayTokens.map(token => {
                    const existingCard = existingCards.get(token.mint);
                    if (existingCard) return existingCard;
                    // Find the new card we just added
                    return newCards.find(card => card.getAttribute('data-mint') === token.mint);
                }).filter(Boolean);
                
                allOrderedCards.forEach(card => {
                    this.tokensContainer.appendChild(card);
                });
                
                // Force reflow
                this.tokensContainer.offsetHeight;
                
                // Step 5: Animate existing cards that moved (FLIP) and fade in new cards
                requestAnimationFrame(() => {
                    // Animate existing cards that moved
                    cardsToKeep.forEach(token => {
                        const card = existingCards.get(token.mint);
                        if (card) {
                            const rect = card.getBoundingClientRect();
                            const newX = rect.left - containerRect.left;
                            const newY = rect.top - containerRect.top;
                            
                            const oldPos = cardsToKeepPositions.get(card);
                            if (oldPos) {
                                const deltaX = oldPos.x - newX;
                                const deltaY = oldPos.y - newY;
                                
                                if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
                                    card.style.transition = 'none';
                                    card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
                                    
                                    requestAnimationFrame(() => {
                                        card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
                                        card.style.transform = 'translate(0, 0)';
                                    });
                                }
                            }
                        }
                    });
                    
                    // Fade in new cards
                    newCards.forEach(card => {
                        card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                        card.style.opacity = '1';
                        card.style.transform = 'scale(1)';
                    });
                });
                
                // Step 6: Re-attach handlers and restore images
                this.attachCardHandlers();
                
                // Store which images are already loaded
                const loadedImageMints = new Set();
                displayTokens.forEach(token => {
                    if (token.mint) {
                        const imageUrl = `https://images.pump.fun/coin-image/${token.mint}?variant=86x86`;
                        if (this.loadedImages.has(imageUrl)) {
                            loadedImageMints.add(token.mint);
                        }
                    }
                });
                
                // Restore images and apply styles
                displayTokens.forEach(token => {
                    const card = this.tokensContainer.querySelector(`[data-mint="${token.mint}"]`);
                    if (card) {
                        // Apply gold glow if token is complete
                        if (token.complete) {
                            card.classList.add('token-complete');
                        }
                        // Apply DexScreener profile indicator
                        if (token.hasDexProfile) {
                            card.classList.add('has-dex-profile');
                        }
                        
                        if (loadedImageMints.has(token.mint)) {
                            const img = card.querySelector('img[data-src]');
                            const placeholder = card.querySelector('.token-image-placeholder-full');
                            if (img && placeholder) {
                                const imageUrl = `https://images.pump.fun/coin-image/${token.mint}?variant=86x86`;
                                img.src = imageUrl;
                                img.style.display = 'block';
                                img.style.visibility = 'visible';
                                placeholder.style.display = 'none';
                            }
                        }
                    }
                });
                
                // Load images that weren't already loaded
                this.loadTokenImages();
                
                // Clean up styles after animations
                setTimeout(() => {
                    allOrderedCards.forEach(card => {
                        card.style.transition = '';
                        card.style.transform = '';
                        card.style.opacity = '';
                    });
                }, 350);
            }
        } else {
            // Just update values in place
            displayTokens.forEach(token => {
                const card = existingCards.get(token.mint);
                if (card) {
                    this.updateTokenCardValues(card, token);
                }
            });
        }
    }

    updateTokenCard(mint, hasNewBuy = false, hasNewSell = false) {
        const token = this.tokens.get(mint);
        if (!token) return;
        
        const card = this.tokensContainer.querySelector(`[data-mint="${mint}"]`);
        if (card) {
            this.updateTokenCardValues(card, token);
            
            // Update banner if it exists or was added
            const hasBanner = token.banner_uri && token.banner_uri !== null && token.banner_uri.trim() !== '';
            const existingBanner = card.querySelector('.token-banner-hover');
            
            if (hasBanner) {
                if (!existingBanner) {
                    // Add banner element
                    const bannerHtml = `<div class="token-banner-hover"><img src="${this.escapeHtml(token.banner_uri)}" alt="${this.escapeHtml(token.name || 'Token')} banner" onerror="this.parentElement.style.display='none';"></div>`;
                    card.insertAdjacentHTML('afterbegin', bannerHtml);
                    card.classList.add('has-banner');
                } else {
                    // Update banner image if URI changed
                    const bannerImg = existingBanner.querySelector('img');
                    if (bannerImg && bannerImg.src !== token.banner_uri) {
                        bannerImg.src = token.banner_uri;
                        existingBanner.style.display = '';
                    }
                }
            } else if (existingBanner) {
                // Remove banner if it no longer exists
                existingBanner.remove();
                card.classList.remove('has-banner');
            }
            
            // Add pulse animation for buys and sells
            if (hasNewBuy) {
                card.classList.add('pulse-buy');
                setTimeout(() => {
                    card.classList.remove('pulse-buy');
                }, 1000);
            }
            if (hasNewSell) {
                card.classList.add('pulse-sell');
                setTimeout(() => {
                    card.classList.remove('pulse-sell');
                }, 1000);
            }
        } else {
            // Card doesn't exist, re-render all
            this.renderTokens();
        }
    }

    updateTokenCardValues(card, token) {
        const marketCapUSD = (token.value || 0) * this.solanaPriceUSD;
        const totalVolumeUSD = ((token.buyVolume || 0) + (token.sellVolume || 0)) * this.solanaPriceUSD;
        
        // Update marketcap
        const marketcapValue = card.querySelector('[data-field="marketcap"]');
        if (marketcapValue) {
            marketcapValue.textContent = this.formatUSD(marketCapUSD);
        }
        
        // Update volume (formatUSD already formats in K/M format)
        const volumeValue = card.querySelector('[data-field="volume"]');
        if (volumeValue) {
            volumeValue.textContent = this.formatUSD(totalVolumeUSD);
        }
        
        // Update progress bar
        const MIN_SOL = 30;
        const MAX_SOL = 420;
        const currentMarketCapSol = token.value || 0;
        const athMarketCapSol = token.allTimeHigh || currentMarketCapSol;
        const range = MAX_SOL - MIN_SOL;
        const currentProgress = Math.max(0, Math.min(100, ((currentMarketCapSol - MIN_SOL) / range) * 100));
        const athProgress = Math.max(0, Math.min(100, ((athMarketCapSol - MIN_SOL) / range) * 100));
        const athUSD = athMarketCapSol * this.solanaPriceUSD;
        
        const progressFill = card.querySelector('[data-field="progress-fill"]');
        if (progressFill) {
            progressFill.style.width = `${currentProgress}%`;
        }
        
        // Update or create ATH marker
        let athMarker = card.querySelector('[data-field="ath-marker"]');
        if (athProgress > currentProgress) {
            if (!athMarker) {
                // Create ATH marker if it doesn't exist
                const progressBar = card.querySelector('[data-field="progress"]');
                if (progressBar) {
                    athMarker = document.createElement('div');
                    athMarker.className = 'token-progress-ath-marker';
                    athMarker.setAttribute('data-field', 'ath-marker');
                    athMarker.setAttribute('title', `All Time High: ${this.formatUSD(athUSD)}`);
                    progressBar.appendChild(athMarker);
                }
            }
            if (athMarker) {
                athMarker.style.left = `${athProgress}%`;
                athMarker.setAttribute('title', `All Time High: ${this.formatUSD(athUSD)}`);
            }
        } else if (athMarker) {
            // Remove ATH marker if current price is at or above ATH
            athMarker.remove();
        }
        
        // Update buys (in Tx section)
        const buysValue = card.querySelector('[data-field="buys"]');
        if (buysValue) {
            buysValue.textContent = token.totalBuys || 0;
        }
        
        // Update sells (in Tx section)
        const sellsValue = card.querySelector('[data-field="sells"]');
        if (sellsValue) {
            sellsValue.textContent = token.totalSells || 0;
        }
    }

    attachCardHandlers() {
        // Add click handlers and hover tracking for token cards
        document.querySelectorAll('.dex-token-card').forEach(card => {
            // Check if handlers already attached (prevent duplicates)
            if (card.dataset.handlersAttached === 'true') {
                return;
            }
            card.dataset.handlersAttached = 'true';
            
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
            
            // Track hover state
            card.addEventListener('mouseenter', () => {
                this.isHoveringToken = true;
            });
            
            card.addEventListener('mouseleave', () => {
                this.isHoveringToken = false;
                // Trigger pending render if one was queued
                if (this.renderPending) {
                    // If it's a volume sort, allow the resort since timer was triggered
                    if (this.isVolumeSort()) {
                        this.allowVolumeResort = true;
                    }
                    requestAnimationFrame(() => {
                        this.renderTokens();
                    });
                }
            });
            
            // Add social link tooltip handlers
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
    }

    loadTokenImages() {
        setTimeout(() => {
            document.querySelectorAll('.dex-token-card img[data-src]').forEach(img => {
                const src = img.getAttribute('data-src');
                if (!src) return;
                
                // Find the placeholder (it's the previous sibling now since placeholder comes first in HTML)
                const placeholder = img.previousElementSibling;
                
                // Skip if image is already visible (already loaded)
                if (img.style.display === 'block' && img.style.visibility === 'visible' && img.complete) {
                    return;
                }
                
                // Check if this image is already loaded (either in our cache or already in DOM)
                if (this.loadedImages.has(src)) {
                    // Image was in cache, restore it immediately
                    if (img.src !== src) {
                        img.src = src;
                    }
                    img.style.display = 'block';
                    img.style.visibility = 'visible';
                    if (placeholder && placeholder.classList.contains('token-image-placeholder-full')) {
                        placeholder.style.display = 'none';
                    }
                } else if (img.src && img.complete && img.naturalWidth > 0) {
                    // Image is already loaded in DOM (checking current src), preserve it
                    img.style.display = 'block';
                    img.style.visibility = 'visible';
                    if (placeholder && placeholder.classList.contains('token-image-placeholder-full')) {
                        placeholder.style.display = 'none';
                    }
                    this.loadedImages.add(src);
                } else if (!img.src || img.src === window.location.href) {
                    // Image hasn't been loaded yet, initialize loading
                    const tempImg = new Image();
                    tempImg.onload = () => {
                        this.loadedImages.add(src); // Mark as loaded
                        img.src = src;
                        img.style.display = 'block';
                        img.style.visibility = 'visible';
                        if (placeholder && placeholder.classList.contains('token-image-placeholder-full')) {
                            placeholder.style.display = 'none';
                        }
                    };
                    tempImg.onerror = () => {
                        // Keep placeholder on error
                        img.style.display = 'none';
                    };
                    tempImg.src = src;
                }
            });
        }, 1000);
    }

    deleteToken(mint) {
        this.tokens.delete(mint);
        // Remove image from loaded images cache
        const imageUrl = `https://images.pump.fun/coin-image/${mint}?variant=86x86`;
        this.loadedImages.delete(imageUrl);
        this.renderTokens();
    }

    addGoldGlow(mint) {
        const card = this.tokensContainer.querySelector(`[data-mint="${mint}"]`);
        if (card) {
            card.classList.add('token-complete');
        }
    }

    loadSettingsFromStorage() {
        try {
            const stored = localStorage.getItem('tokenAlertSettings');
            if (stored) {
                const parsed = JSON.parse(stored);
                this.settings = { ...this.settings, ...parsed };
                // Update UI to reflect loaded settings
                this.updateSettingsButtons();
                this.updateAlertVolumeSlider();
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

    updateAlertVolumeSlider() {
        if (this.alertVolumeSlider && this.alertVolumeValue) {
            this.alertVolumeSlider.value = this.settings.alertVolume || 50;
            this.alertVolumeValue.textContent = `${this.settings.alertVolume || 50}%`;
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
                    this.verifyAndRestoreSession().catch(error => {
                        console.error('Error verifying session:', error);
                    });
                }
            } else {
                // No session, update button
                this.updateLoginButtonText();
            }
        } catch (error) {
            console.error('Error loading user session from localStorage:', error);
            // Clear invalid session
            localStorage.removeItem('userSession');
            this.updateLoginButtonText();
        }
    }

    async verifyAndRestoreSession() {
        if (!this.currentUser) {
            this.updateLoginButtonText();
            return;
        }
        
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
                this.updateLoginButtonText();
            } else {
                // Session is invalid, clear it
                this.currentUser = null;
                localStorage.removeItem('userSession');
                this.updateLoginButtonText();
            }
        } catch (error) {
            console.error('Error verifying user session:', error);
            // On error, keep the session and update button
            this.updateLoginButtonText();
        }
    }

    updateLoginButtonText() {
        if (!this.loginBtn) return;
        
        if (this.currentUser) {
            // Show username when logged in
            this.loginBtn.innerHTML = `
                <span class="btn-icon">👤</span>
                ${this.escapeHtml(this.currentUser.username)}
            `;
        } else {
            // Show "Login" when not logged in
            this.loginBtn.innerHTML = `
                <span class="btn-icon">🔑</span>
                Login
            `;
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // DM Alerts Modal Methods
    openDmAlertsModal() {
        if (!this.dmAlertsModal) return;
        this.dmAlertsModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        
        // Set URL hash based on login status
        if (this.currentUser) {
            window.location.hash = '#profile';
        } else {
            window.location.hash = '#login';
        }
        
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
            // Check Telegram status
            this.checkTelegramStatus();
        }
    }
    
    closeDmAlertsModal() {
        if (!this.dmAlertsModal) return;
        this.dmAlertsModal.classList.remove('active');
        document.body.style.overflow = '';
        // Clear URL hash
        if (window.location.hash) {
            window.history.replaceState(null, null, window.location.pathname);
        }
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
                
                // Update URL hash to #profile
                window.location.hash = '#profile';
                
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
                
                // Clear form
                if (this.usernameInput) this.usernameInput.value = '';
                if (this.passwordInput) this.passwordInput.value = '';
                this.pendingUsername = null;
                
                this.showToast('Profile created successfully!', 'success');
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
                
                // Update URL hash to #profile
                window.location.hash = '#profile';
                
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
                
                // Clear login form
                if (this.loginUsername) this.loginUsername.value = '';
                if (this.loginPassword) this.loginPassword.value = '';
                
                this.showToast('Logged in successfully!', 'success');
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
            this.linkTelegramBtn.innerHTML = '<span>Link to Telegram</span>';
            this.linkTelegramBtn.disabled = true;
            this.linkTelegramBtn.style.opacity = '0.6';
            this.linkTelegramBtn.style.cursor = 'not-allowed';
            this.linkTelegramBtn.classList.remove('btn-success');
        }
        
        // Clear login form
        if (this.loginUsername) this.loginUsername.value = '';
        if (this.loginPassword) this.loginPassword.value = '';
        
        this.showToast('Logged out successfully', 'success');
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

    saveUserSessionToStorage() {
        try {
            if (this.currentUser) {
                localStorage.setItem('userSession', JSON.stringify({
                    username: this.currentUser.username,
                    password: this.currentUser.password
                }));
            }
        } catch (error) {
            console.error('Error saving user session to localStorage:', error);
        }
    }

    clearUserSessionFromStorage() {
        try {
            localStorage.removeItem('userSession');
        } catch (error) {
            console.error('Error clearing user session from localStorage:', error);
        }
    }

    openSettingsModal() {
        this.updateSettingsButtons();
        this.updateAlertVolumeSlider();
        this.settingsModal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }

    closeSettingsModal() {
        this.settingsModal.classList.remove('active');
        document.body.style.overflow = ''; // Restore scrolling
        // Revert theme if it was changed but not saved
        this.applyTheme(this.settings.theme || 'pump');
        this.updateSettingsButtons();
    }

    saveSettings() {
        // Get selected token click option
        const activeButton = Array.from(this.settingsOptionButtons).find(btn => btn.classList.contains('active'));
        if (activeButton) {
            this.settings.tokenClickOption = activeButton.getAttribute('data-value');
        }
        
        // Get volume from slider (already saved on change event, but save again to be sure)
        if (this.alertVolumeSlider) {
            this.settings.alertVolume = parseInt(this.alertVolumeSlider.value);
        }
        
        // Get selected theme
        const activeThemeButton = Array.from(this.themeButtons).find(btn => btn.classList.contains('active'));
        if (activeThemeButton) {
            this.settings.theme = activeThemeButton.getAttribute('data-theme');
            this.applyTheme(this.settings.theme);
        }
        
        // Save to localStorage
        this.saveSettingsToStorage();
        
        // Close modal
        this.closeSettingsModal();
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

    startDexScreenerChecks() {
        // Clear existing interval if any
        if (this.dexScreenerCheckInterval) {
            clearInterval(this.dexScreenerCheckInterval);
        }

        // Check immediately, then every 5 seconds
        this.checkDexScreenerProfiles();
        this.dexScreenerCheckInterval = setInterval(() => {
            this.checkDexScreenerProfiles();
        }, 5000);
    }

    stopDexScreenerChecks() {
        if (this.dexScreenerCheckInterval) {
            clearInterval(this.dexScreenerCheckInterval);
            this.dexScreenerCheckInterval = null;
        }
    }

    async checkDexScreenerProfiles() {
        try {
            const response = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
            if (!response.ok) {
                console.error('DexScreener API error:', response.status, response.statusText);
                return;
            }

            const data = await response.json();
            console.log('DexScreener profiles response:', data);

            // Extract mints from the response
            // The API uses "tokenAddress" for the mint address
            let mints = [];
            
            if (Array.isArray(data)) {
                // If data is an array, extract tokenAddress from each item
                data.forEach(item => {
                    if (item.tokenAddress) {
                        mints.push(item.tokenAddress);
                    }
                });
            } else if (data.tokens && Array.isArray(data.tokens)) {
                // If data has a tokens array
                data.tokens.forEach(token => {
                    if (token.tokenAddress) {
                        mints.push(token.tokenAddress);
                    }
                });
            } else if (data.data && Array.isArray(data.data)) {
                // If data has a data array
                data.data.forEach(item => {
                    if (item.tokenAddress) {
                        mints.push(item.tokenAddress);
                    }
                });
            }

            console.log('Extracted mints from DexScreener:', mints);

            // Check which tokens in memory match
            const matchingMints = [];
            const newProfileMints = [];
            this.tokens.forEach((token, mint) => {
                if (mints.includes(mint)) {
                    matchingMints.push(mint);
                    // Mark token as having DexScreener profile
                    if (!token.hasDexProfile) {
                        token.hasDexProfile = true;
                        newProfileMints.push(mint);
                        // Update the card to show green check
                        this.updateTokenCardDexProfile(mint, true);
                    }
                } else {
                    // Remove flag if token no longer has profile
                    if (token.hasDexProfile) {
                        token.hasDexProfile = false;
                        this.updateTokenCardDexProfile(mint, false);
                        // Clear payment status tracking when profile is removed
                        this.dexPaymentStatuses.delete(mint);
                    }
                }
            });

            console.log('Matching tokens with DexScreener profiles:', matchingMints);
            
            // Start payment checks if we have new profiles
            if (newProfileMints.length > 0) {
                this.startDexPaymentChecks();
            }
        } catch (error) {
            console.error('Error checking DexScreener profiles:', error);
        }
    }

    updateTokenCardDexProfile(mint, hasProfile) {
        const card = this.tokensContainer.querySelector(`[data-mint="${mint}"]`);
        if (card) {
            if (hasProfile) {
                card.classList.add('has-dex-profile');
            } else {
                card.classList.remove('has-dex-profile');
                // Remove payment status classes when profile is removed
                card.classList.remove('dex-status-processing', 'dex-status-approved', 'dex-status-cancelled');
            }
        }
    }

    startDexPaymentChecks() {
        // Clear existing interval if any
        if (this.dexPaymentCheckInterval) {
            clearInterval(this.dexPaymentCheckInterval);
        }

        // Get tokens with DexScreener profiles
        const tokensWithProfiles = Array.from(this.tokens.entries())
            .filter(([mint, token]) => token.hasDexProfile)
            .map(([mint]) => mint);

        if (tokensWithProfiles.length === 0) {
            // No tokens with profiles, stop checking
            if (this.dexPaymentCheckInterval) {
                clearInterval(this.dexPaymentCheckInterval);
                this.dexPaymentCheckInterval = null;
            }
            return;
        }

        // Calculate interval based on number of tokens (1.05s per token, minimum 1.05s)
        const interval = Math.max(1050, tokensWithProfiles.length * 1050);

        // Check immediately for startup
        // Only emit event badge for the first token (index 0) that has a payment status
        // All others will just get green checkmarks but no event badges
        this.checkDexPaymentStatuses(tokensWithProfiles, true);
        
        // Start polling for status changes (these will emit event badges for new statuses)
        this.dexPaymentCheckInterval = setInterval(() => {
            const currentTokensWithProfiles = Array.from(this.tokens.entries())
                .filter(([mint, token]) => token.hasDexProfile)
                .map(([mint]) => mint);
            if (currentTokensWithProfiles.length > 0) {
                this.checkDexPaymentStatuses(currentTokensWithProfiles, false);
            } else {
                // No more tokens with profiles, stop checking
                this.stopDexPaymentChecks();
            }
        }, interval);
    }

    stopDexPaymentChecks() {
        if (this.dexPaymentCheckInterval) {
            clearInterval(this.dexPaymentCheckInterval);
            this.dexPaymentCheckInterval = null;
        }
    }

    async checkDexPaymentStatuses(mints, isStartup = false) {
        let firstPaymentFound = false; // Track if we've found the first payment status at startup
        
        for (const mint of mints) {
            try {
                const response = await fetch(`https://api.dexscreener.com/orders/v1/solana/${mint}`);
                if (!response.ok) {
                    continue; // Skip on error
                }

                const data = await response.json();
                if (Array.isArray(data) && data.length > 0) {
                    const status = data[0].status;
                    if (status) {
                        // At startup, only emit event badge for the first token with a payment status (index 0)
                        if (isStartup) {
                            if (!firstPaymentFound) {
                                // First payment found - emit event badge
                                await this.handleDexPaymentStatus(mint, status, false); // Pass false to emit event badge
                                firstPaymentFound = true;
                            } else {
                                // Subsequent payments at startup - just update green checkmarks, no event badge
                                await this.handleDexPaymentStatus(mint, status, true); // Pass true to skip event badge
                            }
                        } else {
                            // After startup - emit event badges for all new status changes
                            await this.handleDexPaymentStatus(mint, status, false);
                        }
                    }
                }
            } catch (error) {
                // Silently handle errors
            }
        }
    }

    async handleDexPaymentStatus(mint, status, isStartup = false) {
        // Get or create status set for this mint
        if (!this.dexPaymentStatuses.has(mint)) {
            this.dexPaymentStatuses.set(mint, new Set());
        }
        const statusSet = this.dexPaymentStatuses.get(mint);
        const hadStatus = statusSet.has(status);

        // Always update the visual status (green checkmarks)
        this.updateTokenCardDexPaymentStatus(mint, status);

        // At startup, mark status as seen but don't emit event badges
        if (isStartup) {
            statusSet.add(status);
            return;
        }

        // After startup, only emit event badges and play sounds if this is a new status change
        if (!hadStatus) {
            // Mark status as seen
            statusSet.add(status);
            
            // Handle processing/approved status - play positive sound and emit event badge
            if (status === 'processing' || status === 'approved') {
                this.playDexAlertSound(false); // Positive dex alert sound
                
                // Emit dex payment event for token events ticker
                const token = this.tokens.get(mint);
                if (token) {
                    await this.emitDexPaymentEvent(token, status);
                }
            }
            // Handle cancelled status - play negative sound and emit event badge
            else if (status === 'cancelled') {
                this.playDexAlertSound(true); // Negative dex alert sound
                
                // Emit dex payment event for token events ticker
                const token = this.tokens.get(mint);
                if (token) {
                    await this.emitDexPaymentEvent(token, status);
                }
            }
        }
    }

    updateTokenCardDexPaymentStatus(mint, status) {
        const card = this.tokensContainer.querySelector(`[data-mint="${mint}"]`);
        if (!card) return;

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

    /**
     * Fetch header image from DexScreener search API
     * @param {string} mintAddress - The token mint address
     * @returns {Promise<string|null>} Header image URL or null if not found
     */
    async getDexScreenerHeader(mintAddress) {
        try {
            const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${mintAddress}`);
            if (!response.ok) {
                return null;
            }
            
            const data = await response.json();
            if (!data || !data.pairs || !Array.isArray(data.pairs) || data.pairs.length === 0) {
                return null;
            }
            
            // Get the first pair (usually the most relevant one)
            const firstPair = data.pairs[0];
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
     * Emit dex payment event with header image fetched from DexScreener if needed
     * @param {Object} token - The token object
     * @param {string} status - The payment status
     */
    async emitDexPaymentEvent(token, status) {
        const marketCapSol = token.marketCapSol || token.value || 0;
        const marketCapUSD = (marketCapSol && this.solanaPriceUSD ? marketCapSol * this.solanaPriceUSD : 0);
        // Get ATH from token if available
        const athMarketCap = token.athMarketCap || 0;
        
        // Fetch header from DexScreener search API (dex payment API doesn't include header)
        const header = await this.getDexScreenerHeader(token.mint);
        
        this.handleTokenEvent({
            type: 'dex-payment',
            token: {
                mint: token.mint,
                name: token.name || 'Unknown',
                symbol: token.symbol || 'UNKNOWN',
                image: token.image || null,
                header: header,
                status: status,
                marketCapSol: marketCapSol,
                marketCapUSD: marketCapUSD,
                athMarketCap: athMarketCap
            }
        });
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

    startTokenEventsUpdates() {
        // Token events are received via socket.io, no polling needed
        // This function is a placeholder for future updates if needed
    }

    startEventTokenUpdates() {
        // Update latest 8 event tokens every 5 seconds
        this.updateEventTokens();
        this.eventTokenUpdateInterval = setInterval(() => {
            this.updateEventTokens();
        }, 5000);
    }

    async updateEventTokens() {
        if (!this.tokenEvents || this.tokenEvents.length === 0) {
            return;
        }

        // Get latest 8 events
        const latestEvents = this.tokenEvents.slice(0, 8);
        const updatePromises = latestEvents.map(async (event) => {
            if (!event.token || !event.token.mint) {
                return;
            }

            try {
                const response = await fetch(`/api/token/${event.token.mint}`);
                if (!response.ok) {
                    return;
                }

                const data = await response.json();
                if (!data) {
                    return;
                }

                // Store previous marketcap for comparison
                const previousMarketcap = this.eventTokenPreviousMarketcaps.get(event.token.mint) || event.token.marketCapUSD || 0;
                this.eventTokenPreviousMarketcaps.set(event.token.mint, data.marketCapUSD || 0);

                // Update event token data
                event.token.marketCapUSD = data.marketCapUSD || 0;
                event.token.marketCapSol = data.marketCapSol || 0;
                event.token.athMarketCap = data.athMarketCap || 0;
                event.token.previousMarketcap = previousMarketcap;

                // Update the DOM element
                const itemElement = this.tokenEventsTicker?.querySelector(`[data-event-id="${event.id}"]`);
                if (itemElement) {
                    this.updateEventItemElement(itemElement, event);
                }
            } catch (error) {
                console.error(`Error updating token ${event.token.mint}:`, error);
            }
        });

        await Promise.all(updatePromises);
    }

    updateEventItemElement(itemElement, event) {
        const token = event.token;
        const marketCapUSD = token.marketCapUSD || 0;
        const marketCapFormatted = marketCapUSD > 0 ? this.formatUSD(marketCapUSD) : 'N/A';
        const athMarketCap = token.athMarketCap || 0;

        // Update marketcap with color based on change
        const marketcapElement = itemElement.querySelector('.token-events-marketcap');
        if (marketcapElement) {
            marketcapElement.textContent = marketCapFormatted;
            
            // Remove previous color classes
            marketcapElement.classList.remove('marketcap-up', 'marketcap-down');
            
            // Add color based on change
            if (token.previousMarketcap && token.previousMarketcap > 0) {
                if (marketCapUSD > token.previousMarketcap) {
                    marketcapElement.classList.add('marketcap-up');
                } else if (marketCapUSD < token.previousMarketcap) {
                    marketcapElement.classList.add('marketcap-down');
                }
            }
        }

        // Update ATH
        const athElement = itemElement.querySelector('.token-events-ath');
        if (athMarketCap > 0) {
            const athFormatted = this.formatUSD(athMarketCap);
            if (athElement) {
                athElement.textContent = `ATH: ${athFormatted}`;
            } else {
                // Add ATH element if it doesn't exist
                const contentElement = itemElement.querySelector('.token-events-content');
                if (contentElement) {
                    const athSpan = document.createElement('span');
                    athSpan.className = 'token-events-ath';
                    athSpan.textContent = `ATH: ${athFormatted}`;
                    contentElement.appendChild(athSpan);
                }
            }
        } else if (athElement) {
            // Remove ATH element if marketcap is 0
            athElement.remove();
        }

        // Update data attribute
        itemElement.setAttribute('data-marketcap', marketCapUSD);
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

    async handleTokenEvent(eventData) {
        if (!eventData || !eventData.type || !eventData.token) {
            console.warn('[Scout] Invalid token event data:', eventData);
            return;
        }

        console.log('[Scout] Handling token event:', eventData.type, 'for token:', eventData.token.mint?.substring(0, 8) || 'no mint');

        const event = {
            id: `${eventData.type}-${eventData.token.mint}-${Date.now()}`,
            type: eventData.type,
            token: eventData.token,
            timestamp: Date.now()
        };

        // Play low tone sound for new event
        await this.playLowTone();
        
        console.log('[Scout] Event created:', event.id, 'Type:', event.type);

        // Limit to 20 events maximum (remove oldest if exceeded)
        const maxEvents = 20;
        if (this.tokenEvents.length >= maxEvents) {
            // Remove the last (oldest) event from array and animate it out from DOM
            const oldestEvent = this.tokenEvents.pop();
            if (oldestEvent && this.tokenEventsTicker) {
                const oldItem = this.tokenEventsTicker.querySelector(`[data-event-id="${oldestEvent.id}"]`);
                if (oldItem) {
                    // Animate out the old item
                    oldItem.classList.add('slide-out');
                    setTimeout(() => {
                        if (oldItem.parentNode) {
                            oldItem.remove();
                        }
                    }, 300); // Match animation duration
                }
            }
        }
        
        // Add event to the beginning of the list
        this.tokenEvents.unshift(event);
        
        console.log('[Scout] Event added to tokenEvents array. Total events:', this.tokenEvents.length);

        // Render the ticker with slide-in animation for new event
        this.renderTokenEventsTicker(true);
        
        console.log('[Scout] Ticker rendered for event:', event.type);
    }

    renderTokenEventsTicker(isNewEvent = false) {
        console.log('[Scout] renderTokenEventsTicker called, isNewEvent:', isNewEvent, 'tokenEvents.length:', this.tokenEvents?.length || 0);
        
        if (!this.tokenEventsTicker || !this.tokenEventsTickerContainer) {
            console.warn('[Scout] ❌ Ticker elements not found:', {
                hasTicker: !!this.tokenEventsTicker,
                hasContainer: !!this.tokenEventsTickerContainer
            });
            return;
        }

        // Always show the container (it should be visible by default now)
        if (this.tokenEventsTickerContainer) {
            this.tokenEventsTickerContainer.style.display = 'flex';
        }

        if (!this.tokenEvents || this.tokenEvents.length === 0) {
            // Show "Waiting for token events..." message when no events
            if (this.tokenEventsTicker) {
                this.tokenEventsTicker.innerHTML = '<div class="token-events-waiting">Waiting for token events...</div>';
            }
            return;
        }

        // If it's a new event, only add the new one (first in array)
        if (isNewEvent && this.tokenEvents.length > 0) {
            const newEvent = this.tokenEvents[0];
            const newItem = this.createEventItem(newEvent);
            
            // Insert at the beginning
            this.tokenEventsTicker.insertAdjacentHTML('afterbegin', newItem);
            
            // Attach click handler to the new item
            const newItemElement = this.tokenEventsTicker.querySelector(`[data-event-id="${newEvent.id}"]`);
            if (newItemElement) {
                this.attachEventItemHandlers(newItemElement, newEvent);
            }
            
            return;
        }

        // Full re-render (for initial load)
        // Create ticker items
        const tickerItems = this.tokenEvents.map(event => {
            return this.createEventItemHTML(event);
        }).join('');

        // Replace all content
        this.tokenEventsTicker.innerHTML = tickerItems;

        // Attach handlers to all items
        this.tokenEvents.forEach(event => {
            const itemElement = this.tokenEventsTicker.querySelector(`[data-event-id="${event.id}"]`);
            if (itemElement) {
                this.attachEventItemHandlers(itemElement, event);
            }
        });
    }
    
    attachTokenEventClickHandlers() {
        // This function is kept for backwards compatibility but now uses attachEventItemHandlers
        // Attach handlers to all items in the ticker
        this.tokenEvents.forEach(event => {
            const itemElement = this.tokenEventsTicker?.querySelector(`[data-event-id="${event.id}"]`);
            if (itemElement) {
                this.attachEventItemHandlers(itemElement, event);
            }
        });
    }
    
    createEventItem(event) {
        return this.createEventItemHTML(event);
    }
    
    createEventItemHTML(event) {
        const token = event.token;
        const imageUrl = token.image || (token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null);
        const symbolText = (token.symbol || '?').substring(0, 6).toUpperCase();
        const name = token.name || 'Unknown';
        const mint = token.mint || '';

        // Get marketcap (prefer USD, fallback to calculating from SOL, or get from tokens Map if available)
        let marketCapUSD = token.marketCapUSD || (token.marketCapSol && this.solanaPriceUSD ? token.marketCapSol * this.solanaPriceUSD : 0);
        if (!marketCapUSD && token.mint && this.tokens.has(token.mint)) {
            // Fallback: get marketcap from tokens Map if available
            const storedToken = this.tokens.get(token.mint);
            if (storedToken) {
                const marketCapSol = storedToken.marketCapSol || storedToken.value || 0;
                marketCapUSD = marketCapSol && this.solanaPriceUSD ? marketCapSol * this.solanaPriceUSD : 0;
            }
        }
        const marketCapFormatted = marketCapUSD > 0 ? this.formatUSD(marketCapUSD) : 'N/A';
        
        // Get ATH
        const athMarketCap = token.athMarketCap || 0;
        const athFormatted = athMarketCap > 0 ? this.formatUSD(athMarketCap) : '';

        let eventEmoji = '';
        let eventContext = '';

        switch (event.type) {
            case 'cto':
                eventEmoji = '🫂';
                eventContext = 'CTO';
                break;
            case 'boost':
                eventEmoji = '⚡';
                const boostAmount = token.amount || 0;
                const boostTotal = token.totalAmount || 0;
                eventContext = `${boostAmount} / ${boostTotal}`;
                break;
            case 'ads':
                eventEmoji = '📣';
                const impressions = token.impressions || 0;
                // Format as "10K Views" instead of "10,000 impressions"
                if (impressions >= 1000000) {
                    eventContext = `${(impressions / 1000000).toFixed(1)}M Views`;
                } else if (impressions >= 1000) {
                    eventContext = `${(impressions / 1000).toFixed(impressions >= 10000 ? 0 : 1)}K Views`;
                } else {
                    eventContext = `${impressions} Views`;
                }
                break;
            case 'og':
                eventEmoji = '🌿';
                eventContext = 'OG Tweet';
                break;
            case 'migration':
                eventEmoji = '🚀';
                eventContext = 'Migration';
                break;
            case 'dex-payment':
                eventEmoji = '✅';
                eventContext = 'Dex Paid';
                break;
            default:
                eventEmoji = '🔔';
                eventContext = event.type;
        }

        // Store initial marketcap for comparison
        if (!this.eventTokenPreviousMarketcaps.has(mint)) {
            this.eventTokenPreviousMarketcaps.set(mint, marketCapUSD);
        }

        // Store header in data attribute for easy retrieval
        const headerUrl = (event.type === 'cto' || event.type === 'boost' || event.type === 'ads') && token.header ? token.header : '';
        
        return `
            <div class="token-events-ticker-item" 
                 data-event-id="${event.id}" 
                 data-mint="${mint}" 
                 data-name="${this.escapeHtml(name)}" 
                 data-symbol="${this.escapeHtml(symbolText)}" 
                 data-event-type="${event.type}"
                 data-marketcap="${marketCapUSD}"
                 data-image="${imageUrl || ''}"
                 data-header="${this.escapeHtml(headerUrl)}"
                 data-description="${this.escapeHtml((event.type === 'cto' || event.type === 'boost' || event.type === 'ads') ? (token.description || '') : '')}"
                 style="cursor: pointer;">
                <div class="token-events-event-header">
                    <span class="event-emoji">${eventEmoji}</span>
                    <span class="event-context">${eventContext}</span>
                </div>
                ${imageUrl ? `<img src="${imageUrl}" alt="${this.escapeHtml(name)}" class="token-events-icon" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
                <div class="token-events-icon-placeholder" style="${imageUrl ? 'display: none;' : ''}">
                    ${symbolText.substring(0, 2)}
                </div>
                <div class="token-events-content">
                    <span class="token-events-symbol">${this.escapeHtml(symbolText)}</span>
                    <span class="token-events-marketcap">${marketCapFormatted}</span>
                    ${athFormatted ? `<span class="token-events-ath">ATH: ${athFormatted}</span>` : ''}
                </div>
            </div>
        `;
    }
    
    attachEventItemHandlers(itemElement, event) {
        // Check if handlers already attached (prevent duplicates)
        if (itemElement.dataset.handlersAttached === 'true') {
            return;
        }
        itemElement.dataset.handlersAttached = 'true';
        
        // Add click handler
        const mint = itemElement.getAttribute('data-mint');
        if (mint) {
            itemElement.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(`https://pump.fun/${mint}`, '_blank');
            });
        }

        // Add hover handler for all events (show tooltip with details)
        // Always retrieve the event from tokenEvents array to ensure we have the complete data including header
        itemElement.addEventListener('mouseenter', (e) => {
            const eventId = itemElement.getAttribute('data-event-id');
            // Find the event from tokenEvents array (has complete data including header)
            const eventData = this.tokenEvents.find(ev => ev.id === eventId) || event;
            
            this.showTokenEventTooltip(e, eventData);
        });

        itemElement.addEventListener('mouseleave', () => {
            this.hideTokenEventTooltip();
        });
    }
    
    extractTwitterHandle(twitterUrl) {
        if (!twitterUrl) {
            return null;
        }
        // Extract handle from URLs like https://x.com/elonmusk/status/... or https://twitter.com/elonmusk/status/...
        const match = twitterUrl.match(/(?:x\.com|twitter\.com)\/([^\/]+)/i);
        return match ? match[1] : null;
    }

    showTokenEventTooltip(event, eventData) {
        // Remove existing tooltip if any
        const existing = document.getElementById('tokenEventTooltip');
        if (existing) {
            existing.remove();
        }

        const token = eventData.token;
        const name = token.name || 'Unknown';
        const symbol = token.symbol || 'UNKNOWN';
        
        // For CTO, Boost, and Ads events, use DexScreener header image if available, otherwise fallback to token image
        let displayImageUrl = null;
        let isHeaderImage = false;
        if (eventData.type === 'cto' || eventData.type === 'boost' || eventData.type === 'ads') {
            // Use header image from DexScreener if available
            // First try to get header from token object
            let headerValue = token.header;
            
            // If header is not in token object, try to get it from the DOM element's data attribute as fallback
            if ((!headerValue || headerValue === null || headerValue === '') && event.currentTarget) {
                const headerAttr = event.currentTarget.getAttribute('data-header');
                if (headerAttr && headerAttr.trim() !== '' && headerAttr !== 'null') {
                    headerValue = headerAttr;
                }
            }
            
            // Check if header exists and is a valid non-empty string
            const hasHeader = headerValue && 
                             headerValue !== null && 
                             headerValue !== undefined && 
                             headerValue !== '' && 
                             typeof headerValue === 'string' && 
                             headerValue.trim() !== '' &&
                             headerValue.trim().toLowerCase() !== 'null' &&
                             headerValue.trim().toLowerCase() !== 'undefined';
            
            if (hasHeader) {
                displayImageUrl = headerValue.trim();
                isHeaderImage = true;
            } else {
                // Fallback to token image or icon
                displayImageUrl = token.image || (token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null);
            }
        } else {
            // For other events, use token image
            displayImageUrl = token.image || (token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null);
        }
        
        // Get description from DexScreener data (for CTO, Boost, Ads)
        let dexDescription = '';
        if (eventData.type === 'cto' || eventData.type === 'boost' || eventData.type === 'ads') {
            dexDescription = token.description || '';
            // Fallback to data attribute if not in token object
            if (!dexDescription && event.currentTarget) {
                const descAttr = event.currentTarget.getAttribute('data-description');
                if (descAttr && descAttr.trim() !== '') {
                    dexDescription = descAttr;
                }
            }
        }
        
        // Get Twitter handle for OG events
        let twitterHandle = null;
        if (eventData.type === 'og' && token.twitter) {
            twitterHandle = this.extractTwitterHandle(token.twitter);
        }

        // Create tooltip element
        const tooltip = document.createElement('div');
        tooltip.id = 'tokenEventTooltip';
        tooltip.className = 'token-event-tooltip';

        // Use different image class for header images (banner style) vs token icons (circular)
        const imageClass = isHeaderImage ? 'token-event-tooltip-header-image' : 'token-event-tooltip-image';
        const imageContainerClass = isHeaderImage ? 'token-event-tooltip-header-container' : 'token-event-tooltip-image-container';

        let content = `
            <div class="token-event-tooltip-name">${this.escapeHtml(name)}</div>
            <div class="token-event-tooltip-symbol">${this.escapeHtml(symbol)}</div>
            <div class="${imageContainerClass}">
                ${displayImageUrl ? `<img src="${this.escapeHtml(displayImageUrl)}" alt="${this.escapeHtml(name)}" class="${imageClass}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
                <div class="token-event-tooltip-image-placeholder" style="${displayImageUrl ? 'display: none;' : ''}">
                    ${symbol.substring(0, 2).toUpperCase()}
                </div>
            </div>
        `;

        // Add DexScreener description if available
        if (dexDescription) {
            content += `<div class="token-event-tooltip-dex-header">${this.escapeHtml(dexDescription)}</div>`;
        }
        
        // Add Twitter handle for OG events
        if (twitterHandle) {
            content += `<div class="token-event-tooltip-twitter-handle">@${this.escapeHtml(twitterHandle)}</div>`;
        }

        tooltip.innerHTML = content;
        document.body.appendChild(tooltip);

        // Position tooltip near the item
        const rect = event.currentTarget.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        // Position above the item, centered
        tooltip.style.left = `${rect.left + (rect.width / 2) - (tooltipRect.width / 2)}px`;
        tooltip.style.top = `${rect.top - tooltipRect.height - 10}px`;

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
            tooltip.style.top = `${rect.bottom + 10}px`;
        }
    }

    hideTokenEventTooltip() {
        const tooltip = document.getElementById('tokenEventTooltip');
        if (tooltip) {
            tooltip.remove();
        }
    }

    formatNumber(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toString();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    updateTopLiveStream(streamData) {
        if (!this.topLiveStreamContent) {
            console.warn('[Scout] Top live stream content element not found');
            return;
        }

        // Check if this is a new top stream (first assignment or mint changed)
        // Trigger animation if:
        // 1. This is the first stream (previousTopStreamMint is null) OR
        // 2. The mint has changed
        const isNewTopStream = streamData && 
                               streamData.mint && 
                               (this.previousTopStreamMint === null || 
                                this.previousTopStreamMint === undefined ||
                                streamData.mint !== this.previousTopStreamMint);

        this.currentTopStream = streamData;

        if (!streamData) {
            // No stream available
            // Update previous mint to null when stream is cleared
            this.previousTopStreamMint = null;
            this.topLiveStreamContent.innerHTML = '<div class="top-live-stream-waiting">No stream available</div>';
            return;
        }

        // If this is a new top stream, show animation and play sound
        if (isNewTopStream) {
            this.showNewTopStreamAnimation();
            this.playDingSound();
        }

        // Update previous mint after checking if it's new
        if (streamData && streamData.mint) {
            this.previousTopStreamMint = streamData.mint;
        }

        const marketCapFormatted = streamData.marketCapUSD > 0 ? this.formatUSD(streamData.marketCapUSD) : 'N/A';
        const athFormatted = streamData.athMarketCap > 0 ? this.formatUSD(streamData.athMarketCap) : '';
        const imageUrl = streamData.image || (streamData.mint ? `https://images.pump.fun/coin-image/${streamData.mint}?variant=86x86` : null);
        const symbolText = streamData.symbol || 'UNKNOWN';

        const html = `
            <div class="top-live-stream-item" data-mint="${streamData.mint}" style="cursor: pointer;">
                ${imageUrl ? `<img src="${imageUrl}" alt="${this.escapeHtml(streamData.name)}" class="top-live-stream-icon" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
                <div class="top-live-stream-icon-placeholder" style="${imageUrl ? 'display: none;' : ''}">
                    ${symbolText.substring(0, 2)}
                </div>
                <div class="top-live-stream-info">
                    <div class="top-live-stream-symbol-row">
                        <span class="top-live-stream-symbol">${this.escapeHtml(symbolText)}</span>
                        <span class="top-live-stream-participants">👥 ${streamData.participants || 0}</span>
                    </div>
                    <div class="top-live-stream-marketcap">${marketCapFormatted}</div>
                    ${athFormatted ? `<div class="top-live-stream-ath">ATH: ${athFormatted}</div>` : ''}
                </div>
            </div>
        `;

        this.topLiveStreamContent.innerHTML = html;

        // Add click handler
        const streamItem = this.topLiveStreamContent.querySelector('.top-live-stream-item');
        if (streamItem && streamData.mint) {
            streamItem.addEventListener('click', () => {
                window.open(`https://pump.fun/${streamData.mint}`, '_blank');
            });

            // Add hover handler for tooltip
            streamItem.addEventListener('mouseenter', (e) => {
                this.showTopLiveStreamTooltip(e, streamData);
            });

            streamItem.addEventListener('mouseleave', () => {
                this.hideTopLiveStreamTooltip();
            });
        }
    }

    showTopLiveStreamTooltip(event, streamData) {
        // Remove existing tooltip
        const existing = document.getElementById('topLiveStreamTooltip');
        if (existing) {
            existing.remove();
        }

        const name = streamData.name || 'Unknown';
        const symbol = streamData.symbol || 'UNKNOWN';
        const imageUrl = streamData.image || (streamData.mint ? `https://images.pump.fun/coin-image/${streamData.mint}?variant=86x86` : null);
        const thumbnail = streamData.thumbnail || null;

        // Create tooltip element
        const tooltip = document.createElement('div');
        tooltip.id = 'topLiveStreamTooltip';
        tooltip.className = 'token-event-tooltip';

        let content = `
            <div class="token-event-tooltip-name">${this.escapeHtml(name)}</div>
            <div class="token-event-tooltip-symbol">${this.escapeHtml(symbol)}</div>
            <div class="token-event-tooltip-image-container">
                ${imageUrl ? `<img src="${this.escapeHtml(imageUrl)}" alt="${this.escapeHtml(name)}" class="token-event-tooltip-image" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
                <div class="token-event-tooltip-image-placeholder" style="${imageUrl ? 'display: none;' : ''}">
                    ${symbol.substring(0, 2).toUpperCase()}
                </div>
            </div>
        `;

        // Add thumbnail if available
        if (thumbnail) {
            content += `<div class="token-event-tooltip-thumbnail"><img src="${this.escapeHtml(thumbnail)}" alt="Stream thumbnail" onerror="this.style.display='none';"></div>`;
        }

        tooltip.innerHTML = content;
        document.body.appendChild(tooltip);

        // Position tooltip near the item
        const rect = event.currentTarget.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;

        let left = rect.left + scrollX + (rect.width / 2) - (tooltipRect.width / 2);
        let top = rect.bottom + scrollY + 10;

        // Adjust if tooltip goes off screen
        if (left + tooltipRect.width > window.innerWidth + scrollX) {
            left = window.innerWidth + scrollX - tooltipRect.width - 10;
        }
        if (left < scrollX) {
            left = scrollX + 10;
        }
        if (top + tooltipRect.height > window.innerHeight + scrollY) {
            top = rect.top + scrollY - tooltipRect.height - 10;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    hideTopLiveStreamTooltip() {
        const tooltip = document.getElementById('topLiveStreamTooltip');
        if (tooltip) {
            tooltip.remove();
        }
    }

    showNewTopStreamAnimation() {
        if (!this.topLiveStreamSlot) {
            return;
        }

        // Remove existing animation if any
        const existingAnimation = this.topLiveStreamSlot.querySelector('.new-top-stream-badge');
        if (existingAnimation) {
            existingAnimation.remove();
        }

        // Create animation badge
        const badge = document.createElement('div');
        badge.className = 'new-top-stream-badge';
        badge.textContent = 'New Top Stream';
        this.topLiveStreamSlot.appendChild(badge);

        // Trigger animation
        setTimeout(() => {
            badge.classList.add('slide-in');
        }, 10);

        // Remove badge after animation completes
        setTimeout(() => {
            badge.classList.add('slide-out');
            setTimeout(() => {
                if (badge.parentNode) {
                    badge.remove();
                }
            }, 400);
        }, 2500);
    }

    playDingSound() {
        try {
            // Initialize audio context if needed
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            // Resume audio context if suspended
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }

            // Create a simple ding sound using oscillator
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            // Set frequency for a pleasant ding sound (higher pitch)
            oscillator.frequency.value = 800;
            oscillator.type = 'sine';

            // Set volume envelope (quick attack, quick decay)
            const now = this.audioContext.currentTime;
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(0.3, now + 0.01); // Quick attack
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3); // Quick decay

            // Play the sound
            oscillator.start(now);
            oscillator.stop(now + 0.3);
        } catch (error) {
            console.warn('Error playing ding sound:', error);
        }
    }
}

// Initialize app
let scoutApp;
console.log('[Scout] 🚀 Initializing ScoutApp...');
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[Scout] 🚀 DOMContentLoaded - Creating ScoutApp instance...');
        scoutApp = new ScoutApp();
        console.log('[Scout] 🚀 ScoutApp instance created:', scoutApp);
        // Check if we should open the modal based on URL hash
        if (window.location.hash === '#login' || window.location.hash === '#profile') {
            // Small delay to ensure modal is ready
            setTimeout(() => {
                if (scoutApp && scoutApp.openDmAlertsModal) {
                    scoutApp.openDmAlertsModal();
                }
            }, 100);
        }
    });
} else {
    console.log('[Scout] 🚀 DOM already loaded - Creating ScoutApp instance...');
    scoutApp = new ScoutApp();
    console.log('[Scout] 🚀 ScoutApp instance created:', scoutApp);
    // Check if we should open the modal based on URL hash
    if (window.location.hash === '#login' || window.location.hash === '#profile') {
        // Small delay to ensure modal is ready
        setTimeout(() => {
            if (scoutApp && scoutApp.openDmAlertsModal) {
                scoutApp.openDmAlertsModal();
            }
        }, 100);
    }
}

// Make functions globally available
window.scoutApp = scoutApp;


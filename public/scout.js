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
        this.liveStreamsInterval = null; // Interval for checking live streams
        this.currentLiveStreams = []; // Store current live streams
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
        
        this.initElements();
        this.loadSettingsFromStorage();
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
        this.startLiveStreamsUpdates();
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
        this.liveStreamsTickerContainer = document.getElementById('liveStreamsTickerContainer');
        this.liveStreamsTicker = document.getElementById('liveStreamsTicker');
        this.resortIndicator = document.getElementById('resortIndicator');
        this.helpBtn = document.getElementById('helpBtn');
        this.helpModal = document.getElementById('helpModal');
        this.closeHelpBtn = document.getElementById('closeHelpBtn');
        this.closeHelpBtn2 = document.getElementById('closeHelpBtn2');
    }

    initAlertSound() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (error) {
            console.warn('Web Audio API not supported:', error);
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
        this.socket = io();

        this.socket.on('connect', () => {
            this.statusText.textContent = 'Connected';
            this.statusEl.className = 'status-indicator connected';
            this.canvasAnimations.updateStatus(true);
        });

        this.socket.on('disconnect', () => {
            this.statusText.textContent = 'Disconnected';
            this.statusEl.className = 'status-indicator disconnected';
            this.canvasAnimations.updateStatus(false);
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
        });
    }

    initEventListeners() {
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
        return `
            <div class="dex-token-card${completeClass}${hasDexProfile}" data-mint="${token.mint}">
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

        // Check immediately, then at calculated interval
        this.checkDexPaymentStatuses(tokensWithProfiles);
        this.dexPaymentCheckInterval = setInterval(() => {
            const currentTokensWithProfiles = Array.from(this.tokens.entries())
                .filter(([mint, token]) => token.hasDexProfile)
                .map(([mint]) => mint);
            if (currentTokensWithProfiles.length > 0) {
                this.checkDexPaymentStatuses(currentTokensWithProfiles);
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

    async checkDexPaymentStatuses(mints) {
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
                        this.handleDexPaymentStatus(mint, status);
                    }
                }
            } catch (error) {
                // Silently handle errors
            }
        }
    }

    handleDexPaymentStatus(mint, status) {
        // Get or create status set for this mint
        if (!this.dexPaymentStatuses.has(mint)) {
            this.dexPaymentStatuses.set(mint, new Set());
        }
        const statusSet = this.dexPaymentStatuses.get(mint);
        const hadStatus = statusSet.has(status);

        // Handle processing/approved status - play positive sound once per status
        if (status === 'processing' || status === 'approved') {
            if (!hadStatus) {
                statusSet.add(status);
                this.playDexAlertSound(false); // Positive dex alert sound
                this.updateTokenCardDexPaymentStatus(mint, status);
            }
        }
        // Handle cancelled status - play negative sound once
        else if (status === 'cancelled') {
            if (!hadStatus) {
                statusSet.add(status);
                this.playDexAlertSound(true); // Negative dex alert sound
                this.updateTokenCardDexPaymentStatus(mint, status);
            }
        }
        // Update visual status even if we've already alerted
        else {
            this.updateTokenCardDexPaymentStatus(mint, status);
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

    startLiveStreamsUpdates() {
        // Clear existing interval if any
        if (this.liveStreamsInterval) {
            clearInterval(this.liveStreamsInterval);
        }

        // Check immediately, then every 5 seconds
        this.updateLiveStreamsTicker();
        this.liveStreamsInterval = setInterval(() => {
            this.updateLiveStreamsTicker();
        }, 5000);
    }

    stopLiveStreamsUpdates() {
        if (this.liveStreamsInterval) {
            clearInterval(this.liveStreamsInterval);
            this.liveStreamsInterval = null;
        }
    }

    async updateLiveStreamsTicker() {
        try {
            const response = await fetch('/api/live-streams');
            if (!response.ok) {
                console.error('Live streams API error:', response.status, response.statusText);
                return;
            }

            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                console.error('Failed to parse live streams JSON:', parseError);
                return;
            }

            // Check if data is empty
            if (!data) {
                console.log('Live streams API returned empty response');
                this.currentLiveStreams = [];
                this.renderLiveStreamsTicker();
                return;
            }

            console.log('Live streams response:', data);
            console.log('Response type:', typeof data);
            console.log('Is array:', Array.isArray(data));
            if (data && typeof data === 'object') {
                console.log('Response keys:', Object.keys(data));
            }

            // Get top 8 by num_participants
            let liveStreams = [];
            if (Array.isArray(data)) {
                console.log('Processing as array, length:', data.length);
                liveStreams = data
                    .filter(token => {
                        const isLive = token.is_currently_live === true;
                        const hasParticipants = token.num_participants !== undefined && token.num_participants !== null;
                        return isLive && hasParticipants;
                    })
                    .sort((a, b) => (b.num_participants || 0) - (a.num_participants || 0))
                    .slice(0, 8);
                console.log('Filtered live streams:', liveStreams.length);
            } else if (data && data.data && Array.isArray(data.data)) {
                console.log('Processing as data.data array, length:', data.data.length);
                liveStreams = data.data
                    .filter(token => {
                        const isLive = token.is_currently_live === true;
                        const hasParticipants = token.num_participants !== undefined && token.num_participants !== null;
                        return isLive && hasParticipants;
                    })
                    .sort((a, b) => (b.num_participants || 0) - (a.num_participants || 0))
                    .slice(0, 8);
                console.log('Filtered live streams:', liveStreams.length);
            } else {
                console.warn('Unexpected response structure:', data);
            }

            console.log('Final live streams count:', liveStreams.length);
            this.currentLiveStreams = liveStreams;
            this.renderLiveStreamsTicker();
        } catch (error) {
            console.error('Error fetching live streams:', error);
        }
    }

    renderLiveStreamsTicker() {
        if (!this.liveStreamsTicker || !this.liveStreamsTickerContainer) {
            console.warn('Live streams ticker elements not found');
            return;
        }

        if (!this.currentLiveStreams || this.currentLiveStreams.length === 0) {
            console.log('No live streams to display, hiding ticker');
            this.liveStreamsTickerContainer.style.display = 'none';
            return;
        }

        console.log(`Rendering ${this.currentLiveStreams.length} live streams`);
        // Show the container
        this.liveStreamsTickerContainer.style.display = 'flex';

        // Create ticker items - duplicate for seamless loop
        const tickerItems = this.currentLiveStreams.map(token => {
            const imageUrl = token.image_uri || (token.mint ? `https://images.pump.fun/coin-image/${token.mint}?variant=86x86` : null);
            const symbolText = (token.symbol || '?').substring(0, 4).toUpperCase();
            const name = token.name || 'Unknown';
            const participants = token.num_participants || 0;
            const marketCap = token.usd_market_cap || token.market_cap || 0;
            const athMarketCap = token.ath_market_cap || 0;
            const livestreamTitle = token.livestream_title || '';
            const thumbnail = token.thumbnail || '';
            
            // Format marketcap
            const marketCapFormatted = this.formatUSD(marketCap);
            const athFormatted = this.formatUSD(athMarketCap);
            
            return `
                <div class="live-streams-ticker-item" data-mint="${token.mint || ''}" data-name="${this.escapeHtml(name)}" data-title="${this.escapeHtml(livestreamTitle)}" data-thumbnail="${this.escapeHtml(thumbnail)}" style="cursor: pointer;">
                    ${imageUrl ? `<img src="${imageUrl}" alt="${name}" class="live-streams-icon" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
                    <div class="live-streams-icon-placeholder" style="${imageUrl ? 'display: none;' : ''}">
                        ${symbolText}
                    </div>
                    <span class="live-streams-name">${this.escapeHtml(name)}</span>
                    <div class="live-streams-mc-group">
                        <span class="live-streams-mc">MC: ${marketCapFormatted}</span>
                        <span class="live-streams-ath">ATH: ${athFormatted}</span>
                    </div>
                    <span class="live-streams-participants">👥 ${participants}</span>
                </div>
            `;
        }).join('');

        // Duplicate for seamless scrolling
        this.liveStreamsTicker.innerHTML = tickerItems + tickerItems;
        
        // Attach click handlers to live stream items
        this.attachLiveStreamClickHandlers();
    }

    attachLiveStreamClickHandlers() {
        if (!this.liveStreamsTicker) return;
        
        this.liveStreamsTicker.querySelectorAll('.live-streams-ticker-item').forEach(item => {
            // Remove existing listeners by cloning
            const newItem = item.cloneNode(true);
            item.parentNode.replaceChild(newItem, item);
            
            // Add click handler
            const mint = newItem.getAttribute('data-mint');
            if (mint) {
                newItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.open(`https://pump.fun/${mint}`, '_blank');
                });
            }
            
            // Add hover handlers for tooltip
            const name = newItem.getAttribute('data-name');
            const title = newItem.getAttribute('data-title');
            const thumbnail = newItem.getAttribute('data-thumbnail');
            
            newItem.addEventListener('mouseenter', (e) => {
                this.showLiveStreamTooltip(e, name, title, thumbnail);
            });
            
            newItem.addEventListener('mouseleave', () => {
                this.hideLiveStreamTooltip();
            });
        });
    }

    showLiveStreamTooltip(event, name, title, thumbnail) {
        // Remove existing tooltip if any
        const existing = document.getElementById('liveStreamTooltip');
        if (existing) {
            existing.remove();
        }

        // Create tooltip element
        const tooltip = document.createElement('div');
        tooltip.id = 'liveStreamTooltip';
        tooltip.className = 'live-stream-tooltip';
        
        let content = '';
        
        // Add thumbnail if available
        if (thumbnail && thumbnail.trim()) {
            content += `<img src="${this.escapeHtml(thumbnail)}" alt="${this.escapeHtml(name)}" class="live-stream-tooltip-thumbnail" onerror="this.style.display='none';">`;
        }
        
        content += `<div class="live-stream-tooltip-content">`;
        content += `<div class="live-stream-tooltip-name">${this.escapeHtml(name)}</div>`;
        if (title && title.trim()) {
            content += `<div class="live-stream-tooltip-title">${this.escapeHtml(title)}</div>`;
        }
        content += `</div>`;
        
        tooltip.innerHTML = content;
        
        document.body.appendChild(tooltip);
        
        // Position tooltip near the mouse
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

    hideLiveStreamTooltip() {
        const tooltip = document.getElementById('liveStreamTooltip');
        if (tooltip) {
            tooltip.remove();
        }
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
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app
let scoutApp;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        scoutApp = new ScoutApp();
    });
} else {
    scoutApp = new ScoutApp();
}

// Make functions globally available
window.scoutApp = scoutApp;


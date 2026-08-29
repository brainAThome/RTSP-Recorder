// ===== RTSP Recorder Card v1.3.0 BETA =====
console.log("[RTSP-Recorder] Card Version: 1.3.0 BETA");
// MED-008 Fix: Debug logging behind feature flag
const RTSP_DEBUG = localStorage.getItem('rtsp_recorder_debug') === 'true';
const rtspLog = (...args) => { if (RTSP_DEBUG) console.log('[RTSP]', ...args); };
const rtspInfo = (...args) => { if (RTSP_DEBUG) console.info('[RTSP]', ...args); };
const rtspWarn = (...args) => console.warn('[RTSP]', ...args);  // Warnings always shown
const rtspError = (...args) => console.error('[RTSP]', ...args);  // Errors always shown

if (RTSP_DEBUG) {
    console.info("%c RTSP RECORDER CARD \\n%c v1.3.0 BETA (DEBUG) ", "color: #3498db; font-weight: bold; background: #222; padding: 5px;", "color: #27ae60;");
}

class RtspRecorderCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._selectedDate = null;
        this._selectedCam = 'Alle';
        this._kioskActive = false;
        this._animationsEnabled = true;
        this._cachedHeader = null;
        this._activeTab = 'general';
        this._currentEvent = null;
        this._currentVideoUrl = null;
        // Erweiterte Objektliste: Outdoor + Indoor (v1.0.6)
        this._analysisObjects = [
            'person', 'cat', 'dog', 'bird',
            'car', 'truck', 'bicycle', 'motorcycle', 'bus',
            'tv', 'couch', 'chair', 'bed', 'dining table', 'potted plant',
            'laptop', 'cell phone', 'remote',
            'bottle', 'cup', 'book', 'backpack', 'umbrella', 'suitcase', 'package'
        ];
        this._analysisSelected = new Set(['person']);
        this._analysisDevice = 'cpu';
        this._analysisOverview = { items: [], stats: {} };
        this._analysisOverviewLoaded = false;
        this._analysisLoading = false;
        // Pagination state
        this._analysisPage = 1;
        this._analysisPerPage = 50;
        this._analysisTotalPages = 1;
        this._analysisTotal = 0;
        this._perfSensors = { cpu: null, igpu: null, coral: null };
        this._analysisDeviceOptions = null;
        this._overlayEnabled = false;
        this._analysisDetections = null;
        this._analysisInterval = 2;
        this._analysisFrameSize = null;
        this._lastOverlayKey = null;  // v1.1.0h: Throttle overlay redraws
        this._overlayRAF = null;  // v1.1.0k: requestAnimationFrame ID for smooth overlay
        this._overlayDebounce = null;  // v1.1.0k: Debounce timer for overlay updates
        this._overlayCtx = null;  // v1.2.0: Cached canvas context for performance
        this._detectionsIndex = null;  // v1.2.0: Indexed detections for O(1) lookup
        this._overlaySmoothingEnabled = false;  // v1.2.0: Overlay box smoothing
        this._overlaySmoothingAlpha = 0.35;  // v1.2.0: Smoothing alpha (lerp factor)
        this._smoothedBoxes = {};  // v1.2.0: Current smoothed positions per detection
        this._lastSmoothTime = null;  // v1.2.0: Last animation timestamp
        this._smoothingRAF = null;  // v1.2.0: Continuous RAF for smoothing
        this._runningAnalyses = new Map();  // v1.1.0L: Map of video_path -> {camera, started_at} - pure event-driven
        this._runningRecordings = new Map();  // v1.1.0m: Map of video_path -> {camera, duration, started_at} - pure event-driven
        this._lastOverlaySize = null;  // v1.1.0h: Track size changes
        this._showPerfTab = true;
        this._showPerfPanel = false;
        this._showFooter = true;
        this._debugMode = false;  // v1.2.8: Debug-Modus für technische Anzeigen
        this._people = [];
        this._peopleLoaded = false;
        this._selectedPersonId = null;
        this._analysisFaceSamples = [];
        this._cameraObjectsMap = {};  // v1.1.0: Kamera-spezifische Objekteinstellungen
        this._settingsKey = 'rtsp_recorder_settings';
        this.loadLocalSettings();
        this._detectorStats = null;
        this._statsPolling = null;
        this._systemSensors = {
            cpu: 'sensor.processor_use',
            memory: 'sensor.memory_use_percent',
            temp: 'sensor.processor_temperature',
            load1m: 'sensor.load_1m',
            disk: 'sensor.disk_use_percent'
        };
        this._liveStats = {};
        this._statsHistory = [];
        this._maxHistoryPoints = 60;
        this._analysisProgress = null;  // v1.1.0: Analyse-Fortschritt
        this._lastInferenceAt = null;
        this._lastTotalInferences = null;
        const now = new Date();
        this._calYear = now.getFullYear();
        this._calMonth = now.getMonth();
    }

    setConfig(config) {
        this._config = config || {};
        this._basePath = this._config.base_path || '/media/rtsp_recordings';
        this._thumbBase = '/api/rtsp_recorder/thumbnail'; // v1.0.9: Default auf API-Endpoint
    }


    // v1.1.0 Security: HTML escape helper to prevent XSS
    _escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const str = String(text);
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return str.replace(/[&<>"']/g, m => map[m]);
    }

    // v1.1.0: Called when element is added to DOM (e.g., tab switch back)
    connectedCallback() {
        super.connectedCallback && super.connectedCallback();
        // Check if analysis is running when we become visible again
        if (this._hass && this._renderDone) {
            setTimeout(() => this._checkAndRestoreProgress(), 500);
        }
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._renderDone) {
            this.render();
            this._renderDone = true;
            this.initializeCard(); // v1.0.9: Async initialization
            this.renderCalendar();
        } else {
            // v1.1.0: Check progress on every hass update (for tab switches)
            this._checkAndRestoreProgress();
        }
    }

    // v1.0.9: Async initialization - loadAnalysisConfig first, then loadData
    async initializeCard() {
        await this.loadAnalysisConfig();
        this.loadData();
        // v1.1.0: Check if batch analysis is running and restore progress UI
        this._checkAndRestoreProgress();
        // v1.1.0m: Subscribe to push events FIRST (before sync)
        this._subscribeToEvents();
        // v1.1.0m: Initialize status tracking (pure event-driven - no polling)
        this._initStatusTracking();
    }
    
    // v1.1.0f: Subscribe to Home Assistant events for real-time updates (PUSH)
    _subscribeToEvents() {
        if (this._eventSubscriptions) return; // Already subscribed
        
        console.log('[RTSP-Recorder] Subscribing to push events');
        this._eventSubscriptions = [];
        
        // v1.1.0m: Subscribe to recording events - PURE EVENT-DRIVEN (no polling)
        this._subscribeToEvent('rtsp_recorder_recording_started', (event) => {
            console.log('[RTSP-Recorder] PUSH: Recording started', event.data);
            const { camera, video_path, duration } = event.data;
            if (video_path) {
                // Add to running recordings Map
                this._runningRecordings.set(video_path, { 
                    camera, 
                    duration: duration || 0,
                    started_at: new Date().toISOString()
                });
                // Update UI immediately
                this._updateRecordingUI();
            }
        });
        
        // v1.1.0m: recording_saved fires AFTER video+snapshot are ready
        this._subscribeToEvent('rtsp_recorder_recording_saved', async (event) => {
            console.log('[RTSP-Recorder] PUSH: Recording saved', event.data?.camera);
            const { video_path, camera } = event.data;
            if (video_path) {
                // Remove from running recordings Map
                this._runningRecordings.delete(video_path);
                // Update UI immediately
                this._updateRecordingUI();
            }
            
            // v1.1.0i: Add video directly to timeline WITHOUT waiting for Media Source API
            // This ensures perfect sync between analysis status and timeline visibility
            const videoPath = event.data?.video_path;
            const thumbPath = event.data?.thumbnail_path;
            if (videoPath) {
                const added = this._addVideoToTimeline(videoPath, thumbPath);
                if (added) {
                    console.log('[RTSP-Recorder] PUSH: Video added directly to timeline');
                } else {
                    // Fallback to loadData if direct add failed
                    console.log('[RTSP-Recorder] PUSH: Direct add failed, falling back to loadData');
                    await this.loadData();
                }
            } else {
                await this.loadData();
            }
            
            // v1.2.4: Re-apply recording status after timeline refresh to prevent disappearing indicator
            this._updateRecordingUI();
            
            // v1.2.3: REMOVED _updateAnalysisUI() call here - it caused race condition
            // The analysis_started event hasn't been processed yet, so Map is empty
            // Analysis UI is now purely event-driven via analysis_started/completed events
        });
        
        // v1.1.0L: Subscribe to analysis events - PURE EVENT-DRIVEN (no polling)
        this._subscribeToEvent('rtsp_recorder_analysis_started', (event) => {
            console.log('[RTSP-Recorder] PUSH: Analysis started', event.data);
            const { video_path, camera, started_at } = event.data;
            if (video_path) {
                // Add to running analyses Map
                this._runningAnalyses.set(video_path, { camera, started_at });
                console.log(`[RTSP-Recorder] Running analyses: ${this._runningAnalyses.size}`);
                // Update UI immediately
                this._updateAnalysisUI();
            }
        });
        
        this._subscribeToEvent('rtsp_recorder_analysis_completed', (event) => {
            console.log('[RTSP-Recorder] PUSH: Analysis completed', event.data);
            const { video_path } = event.data;
            if (video_path) {
                // Remove from running analyses Map
                this._runningAnalyses.delete(video_path);
                console.log(`[RTSP-Recorder] Running analyses: ${this._runningAnalyses.size}`);
                // Update UI immediately
                this._updateAnalysisUI();
            }
        });
        
        // v1.2.3: Subscribe to batch analysis progress (PUSH statt Polling)
        this._subscribeToEvent('rtsp_recorder_batch_progress', (event) => {
            console.log('[RTSP-Recorder] PUSH: Batch progress', event.data);
            const progress = event.data || {};
            
            // Store for UI updates
            this._batchProgress = progress;
            
            // Update progress UI
            const root = this.shadowRoot;
            const progressContainer = root.querySelector('#analysis-progress-container');
            const progressBar = root.querySelector('#analysis-progress-bar');
            const progressText = root.querySelector('#analysis-progress-text');
            const btnEl = root.querySelector('#btn-analyze-all');
            
            if (progress.message === 'no_files') {
                // No files to analyze
                this.showToast('ℹ️ Keine neuen Aufnahmen zu analysieren', 'info');
                this._stopBatchUI(btnEl, progressContainer);
            } else if (progress.running && progress.total > 0) {
                // Analysis running - update progress
                const percent = Math.round((progress.current / progress.total) * 100);
                
                if (progressContainer) progressContainer.style.display = 'block';
                if (progressBar) progressBar.style.width = percent + '%';
                if (progressText) {
                    const fileInfo = progress.current_file ? ` - ${progress.current_file}` : '';
                    progressText.textContent = `${progress.current} von ${progress.total} analysiert (${percent}%)${fileInfo}`;
                }
                if (btnEl) {
                    // v1.2.3: Button is clickable to stop analysis
                    btnEl.innerHTML = `⏹️ Stopp (${progress.current}/${progress.total})`;
                    btnEl.style.background = '#c62828';
                    btnEl.disabled = false;
                    btnEl.onclick = () => this._stopBatchAnalysis();
                }
                
                // Fetch stats for live TPU load display
                this.fetchDetectorStats();
                this.updatePerfFooter();
            } else if (progress.cancelled) {
                // v1.2.3: Cancelled by user
                this.showToast(`⏹️ Analyse abgebrochen: ${progress.current} von ${progress.total} analysiert`, 'warning');
                this._stopBatchUI(btnEl, progressContainer);
            } else if (progress.completed) {
                // Completed
                this.showToast(`✅ Analyse abgeschlossen: ${progress.current} Aufnahmen`, 'success');
                if (progressBar) {
                    progressBar.style.width = '100%';
                    progressBar.style.background = '#4caf50';
                }
                if (progressText) {
                    progressText.textContent = `✅ Fertig: ${progress.current} Aufnahmen analysiert`;
                }
                setTimeout(() => this._stopBatchUI(btnEl, progressContainer), 3000);
            }
        });
        
        // v1.2.3: Subscribe to stats updates (PUSH statt Polling)
        this._subscribeToEvent('rtsp_recorder_stats_update', (event) => {
            // Update detector stats from push event
            const stats = event.data || {};
            if (stats.available !== false) {
                this._detectorStats = stats;

                const totalInf = stats.inference_stats?.total_inferences;
                if (typeof totalInf === 'number') {
                    if (this._lastTotalInferences == null || totalInf > this._lastTotalInferences) {
                        this._lastInferenceAt = Date.now();
                    } else if (totalInf === 0) {
                        this._lastInferenceAt = null;
                    }
                    this._lastTotalInferences = totalInf;
                }
                
                // Update live stats from HA sensors included in push
                if (stats.system_stats_ha) {
                    if (!this._liveStats) this._liveStats = {};
                    if (stats.system_stats_ha.cpu !== undefined) {
                        this._liveStats.cpu = { state: stats.system_stats_ha.cpu };
                    }
                    if (stats.system_stats_ha.memory !== undefined) {
                        this._liveStats.memory = { state: stats.system_stats_ha.memory };
                    }
                }
                
                // Update footer immediately
                this.updatePerfFooter();
                
                // Update performance tab if open
                if (this._activeTab === 'performance') {
                    const container = this.shadowRoot.querySelector('#menu-content');
                    if (container) this.renderPerformanceTab(container);
                }
            }
        });
    }
    
    // v1.1.0f: Helper to subscribe to a Home Assistant event
    _subscribeToEvent(eventType, callback) {
        if (!this._hass?.connection) {
            console.warn('[RTSP-Recorder] Cannot subscribe to events - no connection');
            return;
        }
        
        this._hass.connection.subscribeEvents(callback, eventType)
            .then(unsub => {
                this._eventSubscriptions.push(unsub);
                console.log(`[RTSP-Recorder] Subscribed to ${eventType}`);
            })
            .catch(err => {
                console.error(`[RTSP-Recorder] Failed to subscribe to ${eventType}:`, err);
            });
    }
    
    // v1.1.0f: Unsubscribe from events (cleanup)
    _unsubscribeFromEvents() {
        if (this._eventSubscriptions) {
            this._eventSubscriptions.forEach(unsub => {
                if (typeof unsub === 'function') unsub();
            });
            this._eventSubscriptions = null;
            console.log('[RTSP-Recorder] Unsubscribed from all events');
        }
    }
    
    // v1.1.0f: Cleanup when card is removed
    disconnectedCallback() {
        super.disconnectedCallback && super.disconnectedCallback();
        this._unsubscribeFromEvents();
    }
    
    // v1.1.0m: Initialize recording and analysis status (pure event-driven - no polling)
    _initStatusTracking() {
        console.log('[RTSP-Recorder] Initializing status tracking (event-driven, no polling)');
        
        // Sync once from backend (in case page loads while recording/analysis is running)
        this._syncRunningRecordingsOnce();
        this._syncRunningAnalysesOnce();
    }
    
    // v1.1.0m: Sync running recordings from backend on page load (one-time, not polling)
    async _syncRunningRecordingsOnce() {
        try {
            const progress = await this._hass.callWS({ type: 'rtsp_recorder/get_recording_progress' });
            if (progress?.running && progress?.recordings?.length > 0) {
                // Recordings are already running - add to Map if not already there
                progress.recordings.forEach(rec => {
                    const videoPath = rec.video_path || `recording_${rec.camera}`;
                    if (!this._runningRecordings.has(videoPath)) {
                        this._runningRecordings.set(videoPath, {
                            camera: rec.camera,
                            duration: rec.duration || 0,
                            started_at: rec.started_at || new Date().toISOString()
                        });
                    }
                });
                console.log('[RTSP-Recorder] Synced running recordings from backend:', this._runningRecordings.size);
                this._updateRecordingUI();
            }
        } catch (e) {
            console.warn('[RTSP-Recorder] Failed to sync running recordings:', e);
        }
    }
    
    // v1.1.0m: Update recording UI from _runningRecordings Map (pure event-driven)
    _updateRecordingUI() {
        const root = this.shadowRoot;
        if (!root) return;
        
        const statusEl = root.querySelector('#footer-recording-status');
        if (!statusEl) return;
        
        const count = this._runningRecordings.size;
        
        if (count > 0) {
            // Build list of all recording cameras
            const entries = Array.from(this._runningRecordings.entries());
            const cameraList = entries.map(([_, rec]) => {
                const cam = rec.camera ? rec.camera.replace(/_/g, ' ') : 'Unbekannt';
                const dur = rec.duration || 0;
                return `${this._escapeHtml(cam)} (${dur}s)`;
            }).join(', ');
            
            statusEl.innerHTML = `<span style="color: #f44336;">● Aufnahme: ${cameraList}</span>`;
            statusEl.style.display = 'block';
        } else {
            statusEl.style.display = 'none';
        }
    }
    
    // v1.1.0L: Update analysis UI from _runningAnalyses Map (pure event-driven)
    _updateAnalysisUI() {
        const root = this.shadowRoot;
        if (!root) return;
        
        const statusEl = root.querySelector('#footer-analysis-status');
        const textEl = root.querySelector('#analysis-status-text');
        
        // Clear all existing markers first
        this._clearTimelineAnalysisMarkers();
        
        const count = this._runningAnalyses.size;
        console.log(`[RTSP-Recorder] _updateAnalysisUI: ${count} running analyses`);
        
        if (count > 0) {
            // Build display text
            let displayText = '';
            const entries = Array.from(this._runningAnalyses.entries());
            
            if (count === 1) {
                const [videoPath, info] = entries[0];
                const parsed = this._parseVideoFilename(videoPath);
                const elapsed = this._formatElapsed(info.started_at);
                displayText = `${parsed.camera} (${parsed.time})${elapsed}`;
            } else {
                const cameras = [...new Set(entries.map(([_, info]) => info.camera))];
                displayText = `${count}x: ${cameras.slice(0, 2).join(', ')}${cameras.length > 2 ? '...' : ''}`;
            }
            
            // Show footer
            if (statusEl) {
                if (textEl) textEl.textContent = displayText;
                statusEl.style.display = 'block';
            }
            
            // Mark timeline items
            entries.forEach(([videoPath, _]) => {
                this._updateTimelineAnalysisMarkers(videoPath);
            });
        } else {
            // No analyses running - hide footer
            if (statusEl) statusEl.style.display = 'none';
        }
    }
    
    // v1.1.0L: Sync running analyses from backend on page load (one-time, not polling)
    // This handles the case where the page is loaded while an analysis is already running
    async _syncRunningAnalysesOnce() {
        try {
            const progress = await this._hass.callWS({ type: 'rtsp_recorder/get_single_analysis_progress' });
            if (progress?.running && progress?.video_path) {
                // An analysis is already running - add to Map if not already there
                if (!this._runningAnalyses.has(progress.video_path)) {
                    this._runningAnalyses.set(progress.video_path, {
                        camera: this._parseVideoFilename(progress.video_path).camera,
                        started_at: progress.started_at
                    });
                    console.log('[RTSP-Recorder] Synced running analysis from backend:', progress.video_path);
                    this._updateAnalysisUI();
                }
            }
        } catch (e) {
            console.warn('[RTSP-Recorder] Failed to sync running analyses:', e);
        }
    }
    
    // v1.1.0: Stop polling recording progress - NOT USED ANYMORE (always poll)
    _stopRecordingPolling() {
        // Keep polling always - low overhead, reliable detection
    }
    
    // v1.1.0: Update ONLY the recording status in footer (no timeline refresh = no zapping)
    _updateRecordingStatusOnly() {
        const root = this.shadowRoot;
        if (!root) return;
        
        const recordingStatusEl = root.querySelector('#footer-recording-status');
        if (!recordingStatusEl) return;
        
        const rp = this._recordingProgress;
        if (rp && rp.running && rp.recordings && rp.recordings.length > 0) {
            // Build list of all recording cameras
            const cameraList = rp.recordings.map(r => {
                const cam = r.camera ? r.camera.replace(/_/g, ' ') : 'Unbekannt';
                const dur = r.duration || 0;
                return `${cam} (${dur}s)`;
            }).join(', ');
            
            const count = rp.count > 1 ? `(${rp.count}) ` : '';
            recordingStatusEl.textContent = '🔴 Aufnahme ' + count + ': ' + cameraList;
            recordingStatusEl.style.color = '#f44336';
            recordingStatusEl.style.fontSize = '0.75em';
            recordingStatusEl.style.display = 'block';
        } else {
            recordingStatusEl.style.display = 'none';
        }
    }
    
    // v1.1.0: Fetch current recording progress from backend
    async _fetchRecordingProgress() {
        try {
            const progress = await this._hass.callWS({
                type: 'rtsp_recorder/get_recording_progress'
            });
            
            // DEBUG: Log every poll result
            console.log('[RTSP-Recorder] Recording poll result:', progress);
            
            const prevCount = this._prevRecordingCount || 0;
            const currentCount = progress.count || 0;
            
            this._recordingProgress = progress;
            this._prevRecordingCount = currentCount;
            
            // DEBUG: Log status changes
            if (currentCount > 0) {
                console.log('[RTSP-Recorder] Recording ACTIVE:', progress.recordings);
            }
            
            // v1.2.4: Update recording status from event-driven Map (not old cache)
            // The polling is still useful for detecting recording ends, but display comes from Map
            this._updateRecordingUI();
            
            // v1.1.0L: Analysis status is now pure event-driven - just update UI from Map
            this._updateAnalysisUI();
            
            // Detect recording end: count decreased -> at least one recording finished
            if (prevCount > currentCount) {
                console.log(`[RTSP-Recorder] Recording count decreased (${prevCount} -> ${currentCount}), scheduling timeline refresh`);
                // v1.1.0f FIX: Debounce with sliding window - refresh 3s after LAST recording end
                // This batches multiple ending recordings into one refresh
                if (this._pendingTimelineRefresh) {
                    clearTimeout(this._pendingTimelineRefresh);
                }
                this._pendingTimelineRefresh = setTimeout(async () => {
                    console.log('[RTSP-Recorder] Delayed timeline refresh executing NOW');
                    await this.loadData();
                    this.updatePerfFooter();
                    // v1.1.0h: Status restoration now happens automatically in updateView()
                    // No need to manually re-apply markers here anymore
                    this._pendingTimelineRefresh = null;
                    
                    // v1.1.0h: If still analyzing videos not in timeline, schedule another refresh
                    if (this._analysisProgress?.single?.running) {
                        const analyses = this._analysisProgress?.single?.analyses || [];
                        const needsAnotherRefresh = analyses.some(a => {
                            const filename = a.video_path?.split('/').pop()?.replace('.mp4', '');
                            if (!filename) return false;
                            const found = this.shadowRoot?.querySelector(`[src*="${filename}"]`);
                            return !found;
                        });
                        if (needsAnotherRefresh && !this._analysisRefreshScheduled) {
                            this._analysisRefreshScheduled = true;
                            setTimeout(async () => {
                                console.log('[RTSP-Recorder] Additional refresh for missing analysis videos');
                                await this.loadData();
                                // v1.1.0h: updateView() handles status restoration
                                this._analysisRefreshScheduled = false;
                            }, 2000);
                        }
                    }
                }, 3000);
            }
        } catch (e) {
            console.error('[RTSP-Recorder] Error fetching recording progress:', e);
        }
    }
    
    // v1.1.0f: Update analysis status indicator in footer AND timeline markers (supports parallel analyses)
    async _updateAnalysisStatusOnly() {
        const root = this.shadowRoot;
        if (!root) return;
        
        const statusEl = root.querySelector('#footer-analysis-status');
        const textEl = root.querySelector('#analysis-status-text');
        
        try {
            const progress = await this._hass.callWS({ type: 'rtsp_recorder/get_single_analysis_progress' });
            
            // v1.1.0e: Store progress for timeline marking (independent of Performance Panel)
            const wasRunning = this._analysisProgress?.single?.running;
            const isRunning = progress?.running;
            
            // v1.1.0j: FIX - Backend returns single object, not array
            // Convert single progress object to array format for consistent handling
            let analyses = [];
            let analysisCount = 0;
            if (progress?.running && progress?.video_path) {
                // Single analysis running - wrap in array
                analyses = [progress];
                analysisCount = 1;
            } else if (progress?.analyses) {
                // Future: Backend might return array format
                analyses = progress.analyses;
                analysisCount = progress.count || analyses.length;
            }
            
            this._analysisProgress = { single: progress, batch: null };
            
            console.log('[RTSP-Recorder] Analysis progress:', { running: isRunning, count: analysisCount, videoPath: progress?.video_path, analyses: analyses.map(a => a.video_path) });
            
            if (isRunning && analysisCount > 0) {
                // v1.1.0k: ROBUST FIX - Always show analysis status while running
                // Don't check if video is in timeline - analysis status should ALWAYS show
                
                // Clear any pending hide timer - analysis is still running
                if (this._analysisHideTimer) {
                    clearTimeout(this._analysisHideTimer);
                    this._analysisHideTimer = null;
                }
                
                // Track last seen analysis for grace period
                this._lastAnalysisSeen = Date.now();
                
                // v1.1.0k: Build display text showing CAMERA + TIME for ALL running analyses
                let displayText = '';
                if (analysisCount === 1) {
                    const parsed = this._parseVideoFilename(analyses[0].video_path);
                    const elapsed = this._formatElapsed(analyses[0].started_at);
                    displayText = `${parsed.camera} (${parsed.time})${elapsed}`;
                } else {
                    // Multiple analyses - show count and cameras
                    const cameras = [...new Set(analyses.map(a => this._parseVideoFilename(a.video_path).camera))];
                    displayText = `${analysisCount}x: ${cameras.slice(0, 2).join(', ')}${cameras.length > 2 ? '...' : ''}`;
                }
                
                // Update footer indicator - ALWAYS show while analysis is running
                if (statusEl) {
                    if (textEl) textEl.textContent = displayText;
                    statusEl.style.display = 'block';
                }
                
                // v1.1.0k: Mark timeline items - check visibility for markers only
                this._clearTimelineAnalysisMarkers();
                analyses.forEach(a => {
                    const filename = a.video_path?.split('/').pop()?.replace('.mp4', '');
                    if (filename) {
                        // Only add marker if video exists in timeline (otherwise no element to mark)
                        const found = root.querySelector(`[src*="${filename}"]`) || 
                                      root.querySelector(`.fm-item[data-filename*="${filename}"]`);
                        if (found) {
                            this._updateTimelineAnalysisMarkers(a.video_path);
                        }
                    }
                });
            } else {
                // v1.1.0f: Use grace period to avoid flicker during rapid poll cycles
                // Only hide if no analysis was seen in the last 3 seconds
                const timeSinceLastAnalysis = this._lastAnalysisSeen ? Date.now() - this._lastAnalysisSeen : Infinity;
                
                if (timeSinceLastAnalysis > 3000) {
                    // Grace period expired - hide immediately
                    if (statusEl) statusEl.style.display = 'none';
                    this._clearTimelineAnalysisMarkers();
                } else if (!this._analysisHideTimer) {
                    // Start hide timer - will hide after grace period if no new analysis
                    this._analysisHideTimer = setTimeout(() => {
                        if (statusEl) statusEl.style.display = 'none';
                        this._clearTimelineAnalysisMarkers();
                        this._analysisHideTimer = null;
                    }, 3000 - timeSinceLastAnalysis);
                }
            }
        } catch (e) {
            // On error, don't immediately hide - use same grace period logic
            const timeSinceLastAnalysis = this._lastAnalysisSeen ? Date.now() - this._lastAnalysisSeen : Infinity;
            if (timeSinceLastAnalysis > 3000) {
                if (statusEl) statusEl.style.display = 'none';
            }
        }
    }
    
    // v1.1.0d: Helper to format elapsed time
    _formatElapsed(startedAt) {
        if (!startedAt) return '';
        const startTime = new Date(startedAt);
        const now = new Date();
        const diffSec = Math.floor((now - startTime) / 1000);
        return diffSec < 60 ? ` (${diffSec}s)` : ` (${Math.floor(diffSec/60)}m ${diffSec%60}s)`;
    }
    
    // v1.1.0h: Parse video filename to extract camera name and time
    // Format: CameraName_YYYYMMDD_HHMMSS.mp4
    _parseVideoFilename(videoPath) {
        const filename = videoPath?.split('/').pop()?.replace('.mp4', '') || '';
        // Try to extract camera name and timestamp
        // Pattern: CameraName_20260202_181559
        const match = filename.match(/^(.+?)_(\d{8})_(\d{6})$/);
        if (match) {
            const camera = match[1].replace(/_/g, ' ');
            const timeStr = match[3]; // HHMMSS
            const time = `${timeStr.substring(0,2)}:${timeStr.substring(2,4)}`;
            return { camera, time };
        }
        // Fallback: just use filename
        return { camera: filename.substring(0, 15), time: '?' };
    }
    
    // v1.1.0i: Add video directly to timeline when recording_saved event is received
    // This bypasses the Media Source API delay and ensures perfect sync
    _addVideoToTimeline(videoPath, thumbPath) {
        try {
            // Extract info from video path: /media/rtsp_recordings/CameraName/CameraName_20260202_181559.mp4
            const pathParts = videoPath.split('/');
            const filename = pathParts.pop(); // CameraName_20260202_181559.mp4
            const camera = pathParts.pop();   // CameraName (folder name)
            
            // Parse timestamp from filename
            const match = filename.match(/(\d{8})_(\d{6})/);
            if (!match) {
                console.warn('[RTSP-Recorder] Cannot parse timestamp from', filename);
                return false;
            }
            
            const d = match[1]; // YYYYMMDD
            const t = match[2]; // HHMMSS
            const dt = new Date(`${d.substr(0, 4)}-${d.substr(4, 2)}-${d.substr(6, 2)}T${t.substr(0, 2)}:${t.substr(2, 2)}:${t.substr(4, 2)}`);
            const iso = `${d.substr(0, 4)}-${d.substr(4, 2)}-${d.substr(6, 2)}`;
            
            // Build media_content_id like Media Source API would
            const basePath = this._basePath?.replace(/^\/media\//, '') || 'rtsp_recordings';
            const mediaContentId = `media-source://media_source/local/${basePath}/${camera}/${filename}`;
            
            // Check if already exists in _events
            const exists = this._events?.some(e => e.id === mediaContentId);
            if (exists) {
                console.log('[RTSP-Recorder] Video already in timeline:', filename);
                return true; // Already there, consider it success
            }
            
            // v1.1.0i: Use the thumbnail path from event if provided, otherwise construct it
            // Convert /media/rtsp_recordings/thumbs/... to /local/rtsp_recordings/thumbs/...
            let thumbUrl;
            if (thumbPath) {
                // Event provides: /media/rtsp_recordings/thumbs/Camera/filename.jpg
                // We need: /local/rtsp_recordings/thumbs/Camera/filename.jpg
                thumbUrl = thumbPath.replace(/^\/media\//, '/local/');
                console.log('[RTSP-Recorder] Using thumbnail from event:', thumbUrl);
            } else {
                // Fallback: construct from thumbBase
                const thumbBase = this._thumbBase || `/local/rtsp_recordings/thumbs`;
                const thumbFilename = filename.replace(/\.mp4$/i, '.jpg');
                thumbUrl = `${thumbBase}/${camera}/${thumbFilename}`;
                console.log('[RTSP-Recorder] Constructed thumbnail path:', thumbUrl);
            }
            
            const newEvent = {
                id: mediaContentId,
                date: dt,
                cam: camera,
                iso: iso,
                thumb: thumbUrl
            };
            
            // Add to beginning (newest first) and re-sort
            if (!this._events) this._events = [];
            this._events.unshift(newEvent);
            this._events.sort((a, b) => b.date - a.date);
            
            console.log('[RTSP-Recorder] Added video directly to timeline:', filename, 'thumb:', thumbUrl, 'Total events:', this._events.length);
            
            // Update the view
            this.updateView();
            
            return true;
        } catch (e) {
            console.error('[RTSP-Recorder] Failed to add video to timeline:', e);
            return false;
        }
    }
    
    // v1.1.0e: Mark timeline item that is being analyzed (green border + badge)
    _updateTimelineAnalysisMarkers(videoPath) {
        if (!videoPath) return;
        const root = this.shadowRoot;
        const list = root.querySelector('#list');
        if (!list) return;
        
        const videoFilename = videoPath.split('/').pop();
        const videoBasename = videoFilename.replace('.mp4', '');
        const items = list.querySelectorAll('.fm-item');
        let foundVideo = false;
        
        items.forEach(item => {
            // Check if this item's thumbnail matches the analyzing video
            const img = item.querySelector('.fm-thumb-img');
            if (!img) return;
            
            const thumbSrc = img.src || '';
            // Also check data attributes if available
            const itemFilename = item.dataset?.filename || '';
            
            // Match by thumbnail URL OR by data-filename attribute
            const isThisVideo = thumbSrc.includes(videoBasename) || 
                                itemFilename.includes(videoBasename) ||
                                thumbSrc.includes(encodeURIComponent(videoBasename));
            
            if (isThisVideo) {
                foundVideo = true;
                if (!item.classList.contains('analyzing')) {
                    item.classList.add('analyzing');
                    // Add badge if not present
                    const wrap = item.querySelector('.fm-thumb-wrap');
                    if (wrap && !wrap.querySelector('.fm-badge-analyzing')) {
                        const badge = document.createElement('div');
                        badge.className = 'fm-badge-analyzing';
                        badge.innerHTML = '🔄 Analyse';
                        wrap.appendChild(badge);
                    }
                    console.log('[RTSP-Recorder] Marked timeline item as analyzing:', videoFilename);
                }
            }
        });
        
        // v1.1.0f: Don't trigger refreshes for missing videos - let normal recording-end refresh handle it
        // This prevents timeline zapping during analysis
    }
    
    // v1.1.0f: REMOVED automatic refresh for missing analysis videos - causes timeline zapping
    // Videos will appear when recording ends and triggers the normal 3-second delayed refresh
    _scheduleAnalysisRefreshIfNeeded() {
        // Intentionally disabled to prevent timeline zapping
        // The recording-end detection already handles timeline refresh
    }
    
    // v1.1.0f: Clear all analysis markers from timeline
    _clearTimelineAnalysisMarkers() {
        const root = this.shadowRoot;
        const list = root.querySelector('#list');
        if (!list) return;
        
        const items = list.querySelectorAll('.fm-item.analyzing');
        items.forEach(item => {
            item.classList.remove('analyzing');
            const badge = item.querySelector('.fm-badge-analyzing');
            if (badge) badge.remove();
        });
    }
    
    // v1.1.0: Check if batch analysis is running and restore progress bar
    async _checkAndRestoreProgress() {
        // Don't check if already polling
        if (this._progressPollingInterval) {
            return;
        }
        
        try {
            const progress = await this._hass.callWS({
                type: 'rtsp_recorder/get_analysis_progress'
            });
            
            // v1.2.3: Store progress state for tab re-rendering
            if (progress.running) {
                this._batchProgress = progress;
            }
            
            if (progress.running) {
                const root = this.shadowRoot;
                const btnEl = root.querySelector('#btn-analyze-all');
                const originalText = 'Alle Aufnahmen analysieren';
                
                // Start polling to continue showing progress
                this._startProgressPolling(btnEl, originalText);
            }
        } catch (e) {
            // Silently ignore - analysis progress check is optional
        }
    }

    // v1.0.6: Laedt globale Analyse-Konfiguration aus der Integration
    async loadAnalysisConfig() {
        try {
            const config = await this._hass.callWS({
                type: 'rtsp_recorder/get_analysis_config'
            });
            if (config && config.analysis_objects && config.analysis_objects.length > 0) {
                // Aktualisiere die ausgewaehlten Objekte mit den globalen Einstellungen
                this._analysisSelected = new Set(config.analysis_objects);
                console.log('[RTSP-Recorder] Loaded global analysis objects:', config.analysis_objects);
                
                // Aktualisiere die Checkboxen in der UI falls bereits gerendert
                this.shadowRoot.querySelectorAll('.fm-obj').forEach(cb => {
                    cb.checked = this._analysisSelected.has(cb.value);
                });
            }
            if (config && config.analysis_device) {
                this._analysisDevice = config.analysis_device;
                // Aktualisiere das Device-Dropdown falls vorhanden
                const deviceSelect = this.shadowRoot.querySelector('#analysis-device');
                if (deviceSelect) {
                    deviceSelect.value = this._analysisDevice;
                }
            }
            // v1.1.0: Kamera-spezifische Objekteinstellungen speichern
            if (config && config.camera_objects_map) {
                this._cameraObjectsMap = config.camera_objects_map;
            }
            // v1.0.9: Lade Speicherpfade aus der Integration
            if (config && config.storage_path) {
                this._basePath = config.storage_path;
                console.log('[RTSP-Recorder] Using storage_path from integration:', this._basePath);
            }
            // v1.2.0: Overlay-Smoothing aus Config laden
            if (config) {
                this._overlaySmoothingEnabled = config.analysis_overlay_smoothing === true;
                this._overlaySmoothingAlpha = config.analysis_overlay_smoothing_alpha || 0.35;
                console.log('[RTSP-Recorder] Overlay smoothing:', this._overlaySmoothingEnabled, 'alpha:', this._overlaySmoothingAlpha);
            }
            // v1.0.9: Thumbnails ueber API-Endpoint laden (funktioniert mit jedem Pfad)
            this._thumbBase = '/api/rtsp_recorder/thumbnail';
            console.log('[RTSP-Recorder] Using thumbnail API endpoint:', this._thumbBase);
        } catch (e) {
            console.warn('[RTSP-Recorder] Could not load analysis config:', e);
        }
    }

    render() {
        const root = this.shadowRoot;
        root.innerHTML = `
            <style>
                :host { display: block; --primary-color: #03a9f4; --bg-dark: #0d0d0d; --header-bg: #1a1a1a; }
                .fm-container { background: var(--bg-dark); color: #eee; height: 85vh; border-radius: 12px; overflow: hidden; font-family: 'Roboto', sans-serif; display: flex; flex-direction: column; position: relative; }
                .fm-container.kiosk { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 9999; border-radius: 0; margin: 0; }
                .fm-header { height: 64px; display: flex; justify-content: space-between; align-items: center; padding: 0 24px; background: var(--header-bg); border-bottom: 1px solid #222; }
                .fm-title { font-size: 1.2em; font-weight: 500; }
                .fm-toolbar { display: flex; gap: 12px; align-items: center; }
                .fm-btn { background: #2a2a2a; border: 1px solid #333; color: #ccc; padding: 8px 16px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
                .fm-btn.active { color: var(--primary-color); border-color: var(--primary-color); font-weight: bold; }
                .fm-main { display: flex; flex: 1; overflow: hidden; min-height: 0; }
                .fm-player-col { flex: 1; position: relative; background: #000; display: flex; flex-direction: column; align-items: stretch; justify-content: stretch; }
                .fm-player-body { flex: 1; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
                #main-video { width: 100%; height: 100%; object-fit: contain; }
                
                /* v1.3.2: Video Loading Spinner for mobile performance */
                .video-loading-spinner {
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0,0,0,0.8);
                    z-index: 100;
                }
                .video-loading-spinner .spinner {
                    width: 50px;
                    height: 50px;
                    border: 4px solid rgba(255,255,255,0.2);
                    border-top-color: var(--primary-color, #03a9f4);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                .video-loading-spinner .loading-text {
                    margin-top: 15px;
                    color: #fff;
                    font-size: 14px;
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                
                #overlay-canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
                .fm-overlay-tl { position: absolute; top: 20px; left: 20px; background: rgba(0,0,0,0.55); padding: 6px 14px; border-radius: 4px; color: #fff; font-size: 0.9em; font-weight: 600; pointer-events: none; }
                .fm-overlay-tr { position: absolute; top: 20px; right: 20px; background: rgba(0,0,0,0.35); padding: 6px 14px; border-radius: 4px; color: #ccc; font-size: 0.85em; pointer-events: none; }
                .fm-frame-info { position: absolute; top: 52px; right: 20px; background: rgba(0,0,0,0.65); padding: 4px 10px; border-radius: 4px; color: #0f0; font-size: 0.75em; font-family: 'Consolas', 'Monaco', monospace; pointer-events: none; display: none; letter-spacing: 0.5px; }
                .fm-frame-info.visible { display: block; }
                .fm-sidebar { width: 420px; flex-shrink: 0; background: #111; border-left: 1px solid #222; display: flex; flex-direction: column; }
                .fm-scroll { flex: 1; display: flex; overflow-y: auto; }
                .fm-list { flex: 1; min-width: 0; background: #0d0d0d; display: flex; flex-direction: column; }
                .fm-item { height: 160px; padding: 12px; cursor: pointer; border-bottom: 1px solid #333; position: relative; background: #111; }
                .fm-item:hover { background: #1f1f1f; }
                .fm-item.selected { border: 2.5px solid var(--primary-color); border-radius: 8px; background: #222; z-index: 10; margin: 4px; height: 152px; }
                .fm-thumb-wrap { width: 100%; height: 100%; border-radius: 6px; overflow: hidden; position: relative; background: #222; display: flex; align-items: center; justify-content: center; }
                .fm-thumb-img { width: 100%; height: 100%; object-fit: cover; opacity: 0.8; }
                /* REMOVED UPPERCASE HERE */
                .fm-badge-cam { position: absolute; bottom: 12px; left: 12px; background: rgba(0,0,0,0.7); padding: 4px 10px; border-radius: 4px; font-size: 0.7em; color: #fff; font-weight: 700; letter-spacing: 0.5px; text-transform: capitalize; }
                .fm-badge-time { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; font-size: 0.7em; color: #fff; }
                
                /* Mobile Ring-Style Item Info */
                .fm-item-info {
                    display: none; /* Hidden on desktop */
                    flex-direction: column;
                    justify-content: center;
                    flex: 1;
                    min-width: 0;
                }
                .fm-item-cam {
                    font-size: 0.95em;
                    font-weight: 600;
                    color: #fff;
                    text-transform: capitalize;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .fm-item-time {
                    font-size: 0.8em;
                    color: #888;
                    margin-top: 2px;
                }
                
                /* v1.1.0: Analyse-Badge für Timeline Items */
                .fm-item.analyzing { border: 2px solid #4caf50; }
                .fm-item.analyzing .fm-thumb-wrap::after {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: linear-gradient(135deg, rgba(76,175,80,0.15) 0%, rgba(76,175,80,0.05) 100%);
                    pointer-events: none;
                }
                .fm-badge-analyzing {
                    position: absolute;
                    top: 10px;
                    left: 10px;
                    background: linear-gradient(135deg, #4caf50 0%, #2e7d32 100%);
                    color: #fff;
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 0.7em;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    animation: analyzePulse 1.5s ease-in-out infinite;
                }
                @keyframes analyzePulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.7; }
                }
                
                /* v1.1.0: Recording Badge für Timeline Items */
                .fm-item.recording { border: 2px solid #f44336; }
                .fm-item.recording .fm-thumb-wrap::after {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: linear-gradient(135deg, rgba(244,67,54,0.2) 0%, rgba(244,67,54,0.05) 100%);
                    pointer-events: none;
                }
                .fm-badge-recording {
                    position: absolute;
                    top: 10px;
                    left: 10px;
                    background: linear-gradient(135deg, #f44336 0%, #c62828 100%);
                    color: #fff;
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 0.7em;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    animation: recordPulse 1s ease-in-out infinite;
                }
                @keyframes recordPulse {
                    0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(244,67,54,0.5); }
                    50% { opacity: 0.8; box-shadow: 0 0 16px rgba(244,67,54,0.8); }
                }
                
                /* RULER RESTORED */
                .fm-ruler { width: 75px; flex-shrink: 0; background: #141414; border-right: 1px solid #222; position: relative; }
                .fm-tick { height: 160px; border-bottom: 1px solid #1a1a1a; position: relative; display: flex; justify-content: center; padding-top: 15px; }
                .fm-tick::after { content: ''; position: absolute; right: 0; top: 0; width: 12px; height: 1px; background: #444; }
                .fm-tick-label { color: #888; font-size: 0.75em; font-weight: 500; }
                
                /* Popups and Menu Styles */
                .fm-popup { position: absolute; top: 68px; right: 24px; background: #222; border: 1px solid #333; border-radius: 10px; display: none; min-width: 240px; z-index: 2000; box-shadow: 0 20px 60px rgba(0,0,0,0.8); }
                #pop-date { right: 140px; }
                .fm-popup-item { padding: 15px 20px; cursor: pointer; border-bottom: 1px solid #2a2a2a; color: #bbb; display: flex; align-items: center; gap: 12px; }
                .fm-popup-item:hover { background: #333; color: #fff; }
                .fm-popup-item.active { color: var(--primary-color); font-weight: bold; }
                .fm-menu-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 3000; display: none; align-items: center; justify-content: center; }
                .fm-menu-overlay.open { display: flex; }
                .fm-menu-card { background: #1a1a1a; border: 1px solid #333; width: 600px; max-width: 90%; max-height: 90vh; border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; }
                .fm-menu-header { padding: 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; background: #222; }
                .fm-menu-title { font-size: 1.25em; font-weight: 500; color: #fff; }
                .fm-menu-close { cursor: pointer; color: #888; }
                .fm-tabs { display: flex; overflow-x: auto; background: #111; border-bottom: 1px solid #333; }
                .fm-tab { flex: 1 1 auto; min-width: 0; text-align: center; padding: 14px 4px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; text-transform: uppercase; font-size: 0.8em; white-space: nowrap; }
                .fm-tab.active { color: var(--primary-color); border-bottom-color: var(--primary-color); background: #1a1a1a; }
                .fm-tab.hidden { display: none; }
                .fm-menu-content { padding: 30px; min-height: 300px; overflow-y: auto; }
                
                /* Calendar */
                .fm-cal-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; border-bottom: 1px solid #333; background: #222; }
                .fm-cal-btn { background: #333; border: none; color: #fff; width: 30px; height: 30px; border-radius: 4px; cursor: pointer; }
                .fm-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); padding: 10px; gap: 4px; }
                .fm-cal-day { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; color: #bbb; }
                .fm-cal-day.today { border: 1px solid var(--primary-color); }
                .fm-cal-day.selected { background: var(--primary-color); color: #fff; font-weight: bold; }
                .fm-btn-danger { background: rgba(244, 67, 54, 0.15) !important; color: #f44336 !important; border: 1px solid #f44336 !important; width: 100%; padding: 8px; border-radius: 4px; cursor: pointer; transition: 0.2s; }
                .fm-btn-danger:hover { background: #f44336 !important; color: #fff !important; }
                
                /* ========== ANIMATIONS ========== */
                /* Fade-in Animation for Items */
                @keyframes fadeInUp {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes scaleIn {
                    from { opacity: 0; transform: scale(0.95); }
                    to { opacity: 1; transform: scale(1); }
                }
                @keyframes slideIn {
                    from { opacity: 0; transform: translateY(-20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes pulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                }
                
                /* Animated states - only when animations enabled */
                .fm-container.animated .fm-item {
                    animation: fadeInUp 0.4s ease-out backwards;
                    transition: transform 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
                }
                .fm-container.animated .fm-item:hover .fm-thumb-wrap {
                    transform: scale(1.02);
                }
                .fm-container.animated .fm-thumb-wrap {
                    transition: transform 0.25s ease;
                }
                .fm-container.animated .fm-item.selected {
                    animation: pulse 0.3s ease;
                }
                .fm-container.animated #main-video {
                    transition: opacity 0.3s ease;
                }
                .fm-container.animated #main-video.loading {
                    opacity: 0.3;
                }
                .fm-container.animated .fm-menu-overlay {
                    transition: opacity 0.25s ease;
                    opacity: 0;
                }
                .fm-container.animated .fm-menu-overlay.open {
                    opacity: 1;
                }
                .fm-container.animated .fm-menu-card {
                    animation: scaleIn 0.3s ease-out;
                }
                .fm-container.animated .fm-popup {
                    animation: slideIn 0.2s ease-out;
                }
                .fm-container.animated .fm-cal-day {
                    transition: transform 0.15s ease, background 0.15s ease;
                }
                .fm-container.animated .fm-cal-day:hover {
                    transform: scale(1.15);
                }
                .fm-container.animated .fm-cal-day:active {
                    transform: scale(0.95);
                }
                .fm-container.animated .fm-btn {
                    transition: all 0.2s ease;
                }
                .fm-container.animated .fm-btn:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                }
                .fm-container.animated .fm-tick {
                    animation: fadeIn 0.3s ease-out backwards;
                }
                
                /* ========== VIDEO CONTROLS ========== */
                .fm-video-controls {
                    position: absolute;
                    bottom: 60px;
                    left: 20px;
                    display: flex;
                    gap: 8px;
                    z-index: 100;
                    opacity: 0;
                    transition: opacity 0.2s ease;
                }
                .fm-player-col:hover .fm-video-controls {
                    opacity: 1;
                }
                .fm-player-footer {
                    position: relative;
                    margin: 8px 16px 12px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    background: rgba(0,0,0,0.55);
                    border: 1px solid #333;
                    border-radius: 8px;
                    padding: 8px 12px;
                    z-index: 110;
                    pointer-events: auto;
                }
                .fm-footer-left {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                    flex-wrap: wrap;
                }
                .fm-footer-right {
                    display: flex;
                    gap: 3px;
                    align-items: center;
                    flex-wrap: nowrap;
                    flex-shrink: 0;
                }
                /* Mobile action buttons - hidden on desktop */
                .fm-mobile-actions {
                    display: none;
                }
                .fm-toggle {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 0.85em;
                    color: #ddd;
                }
                .fm-perf-card {
                    background: #1b1b1b;
                    border: 1px solid #2a2a2a;
                    border-radius: 4px;
                    padding: 6px 5px;
                    min-width: 44px;
                    text-align: center;
                    flex-shrink: 0;
                }
                .fm-perf-label {
                    font-size: 0.62em;
                    color: #999;
                    line-height: 1.2;
                }
                .fm-perf-value {
                    font-size: 0.85em;
                    font-weight: 600;
                    color: var(--primary-color);
                    line-height: 1.3;
                }
                .fm-ctrl-btn {
                    background: rgba(0,0,0,0.7);
                    border: 1px solid #444;
                    color: #fff;
                    padding: 8px 12px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 0.85em;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    transition: all 0.2s ease;
                }
                .fm-ctrl-btn:hover {
                    background: rgba(3,169,244,0.3);
                    border-color: var(--primary-color);
                }
                .fm-ctrl-btn.active {
                    background: rgba(3,169,244,0.3);
                    border-color: var(--primary-color);
                }
                .fm-ctrl-btn.danger:hover {
                    background: rgba(244,67,54,0.3);
                    border-color: #f44336;
                }
                .fm-speed-btn {
                    min-width: 45px;
                    justify-content: center;
                }
                .fm-speed-btn.active {
                    background: var(--primary-color);
                    border-color: var(--primary-color);
                }
                
                /* ========== STORAGE INFO ========== */
                .fm-storage-bar {
                    height: 20px;
                    background: #333;
                    border-radius: 10px;
                    overflow: hidden;
                    margin: 15px 0;
                }
                .fm-storage-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #4caf50, #8bc34a);
                    border-radius: 10px;
                    transition: width 0.5s ease;
                }
                .fm-storage-fill.warning {
                    background: linear-gradient(90deg, #ff9800, #ffc107);
                }
                .fm-storage-fill.danger {
                    background: linear-gradient(90deg, #f44336, #ff5722);
                }
                .fm-storage-stats {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 15px;
                    margin-top: 20px;
                }
                .fm-stat-card {
                    background: #222;
                    padding: 15px;
                    border-radius: 8px;
                    text-align: center;
                }
                .fm-stat-value {
                    font-size: 1.5em;
                    font-weight: bold;
                    color: var(--primary-color);
                }
                .fm-stat-label {
                    font-size: 0.8em;
                    color: #888;
                    margin-top: 5px;
                }
                
                /* Delete Confirmation */
                .fm-confirm-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0,0,0,0.9);
                    z-index: 4000;
                    display: none;
                    align-items: center;
                    justify-content: center;
                }
                .fm-confirm-overlay.open {
                    display: flex;
                }
                .fm-confirm-card {
                    background: #1a1a1a;
                    border: 1px solid #333;
                    padding: 30px;
                    border-radius: 12px;
                    text-align: center;
                    max-width: 400px;
                }
                .fm-confirm-btns {
                    display: flex;
                    gap: 15px;
                    margin-top: 25px;
                    justify-content: center;
                }
                
                /* ========== MOBILE / PORTRAIT LAYOUT (Ring-Style) ========== */
                @media (max-width: 768px) {
                    /* Container: Full height on mobile */
                    .fm-container {
                        height: 100vh;
                        border-radius: 0;
                    }
                    
                    /* Header: Compact mobile header */
                    .fm-header {
                        height: 52px;
                        padding: 0 12px;
                    }
                    .fm-header .fm-title img {
                        height: 36px;
                    }
                    .fm-header .fm-title span {
                        display: none; /* Hide BETA badge on mobile */
                    }
                    .fm-toolbar {
                        gap: 6px;
                    }
                    .fm-btn {
                        padding: 6px 10px;
                        font-size: 0.8em;
                    }
                    
                    /* Main: Stack vertically instead of side-by-side */
                    .fm-main {
                        flex-direction: column;
                    }
                    
                    /* Video Player: Top 45% */
                    .fm-player-col {
                        flex: none;
                        height: 45%;
                        min-height: 180px;
                    }
                    .fm-overlay-tl, .fm-overlay-tr {
                        padding: 4px 8px;
                        font-size: 0.75em;
                        top: 8px;
                    }
                    .fm-overlay-tl { left: 8px; }
                    .fm-overlay-tr { right: 8px; }
                    
                    /* Video Controls: Hide completely on mobile */
                    .fm-video-controls {
                        display: none;
                    }
                    
                    /* Mobile Action Buttons in Footer */
                    .fm-mobile-actions {
                        display: flex;
                        gap: 8px;
                        margin-left: auto;
                    }
                    .fm-mobile-btn {
                        background: #2a2a2a;
                        border: 1px solid #444;
                        color: #ccc;
                        padding: 6px 10px;
                        border-radius: 4px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        font-size: 0.7em;
                    }
                    .fm-mobile-btn.danger {
                        border-color: #f44336;
                        color: #f44336;
                    }
                    .fm-mobile-btn svg {
                        width: 14px;
                        height: 14px;
                    }
                    
                    /* Player Footer: Compact mobile version */
                    .fm-player-footer {
                        margin: 4px 8px;
                        padding: 6px 8px;
                        flex-direction: column;
                        gap: 6px;
                    }
                    .fm-footer-left {
                        flex-wrap: nowrap;
                        gap: 8px;
                        font-size: 0.75em;
                        width: 100%;
                        justify-content: flex-start;
                    }
                    .fm-footer-left .fm-toggle {
                        gap: 4px;
                        white-space: nowrap;
                    }
                    /* Hide recording/analysis status on mobile - too big */
                    #footer-recording-status,
                    #footer-analysis-status {
                        display: none !important;
                    }
                    /* Perf panel: Show below footer on mobile, compact */
                    .fm-footer-right {
                        width: 100%;
                        margin-top: 6px;
                        font-size: 0.7em;
                        flex-wrap: wrap;
                        gap: 6px;
                    }
                    .fm-footer-right .fm-perf-card {
                        padding: 4px 8px;
                        font-size: 1em;
                        min-width: auto;
                    }
                    
                    /* Sidebar: Bottom 55%, full width */
                    .fm-sidebar {
                        width: 100%;
                        height: 55%;
                        border-left: none;
                        border-top: 1px solid #222;
                    }
                    
                    /* Hide ruler on mobile (saves space) */
                    .fm-ruler {
                        display: none;
                    }
                    
                    /* Timeline Items: Ring-Style horizontal cards */
                    .fm-item {
                        height: 80px;
                        padding: 8px;
                        display: flex;
                        flex-direction: row;
                        gap: 12px;
                        align-items: center;
                    }
                    .fm-item.selected {
                        height: 72px;
                    }
                    
                    /* Thumbnail: Square on left side */
                    .fm-thumb-wrap {
                        width: 100px;
                        height: 64px;
                        flex-shrink: 0;
                        border-radius: 8px;
                    }
                    
                    /* Hide inline badges on mobile */
                    .fm-badge-cam,
                    .fm-badge-time {
                        display: none;
                    }
                    
                    /* Show mobile info section */
                    .fm-item-info {
                        display: flex;
                    }
                    
                    /* Menu overlay: Fullscreen on mobile */
                    .fm-menu-card {
                        width: 100%;
                        max-width: 100%;
                        height: 100%;
                        max-height: 100%;
                        border-radius: 0;
                    }
                    .fm-menu-header {
                        padding: 12px 16px;
                    }
                    .fm-menu-title {
                        font-size: 1.1em;
                    }
                    .fm-menu-content {
                        padding: 16px;
                    }
                    
                    /* Mobile Tabs: Scrollable, compact */
                    .fm-tabs {
                        overflow-x: auto;
                        overflow-y: hidden;
                        -webkit-overflow-scrolling: touch;
                        flex-wrap: nowrap;
                    }
                    .fm-tab {
                        flex: none;
                        padding: 12px 10px;
                        font-size: 0.7em;
                        white-space: nowrap;
                        min-width: auto;
                    }
                    
                    /* Popups: Full width on mobile */
                    .fm-popup {
                        position: fixed;
                        top: auto;
                        bottom: 0;
                        left: 0;
                        right: 0;
                        width: 100%;
                        border-radius: 16px 16px 0 0;
                    }
                }
                
                /* Extra small phones (< 480px) */
                @media (max-width: 480px) {
                    .fm-header {
                        height: 48px;
                        padding: 0 8px;
                    }
                    .fm-header .fm-title img {
                        height: 28px;
                    }
                    .fm-btn {
                        padding: 5px 8px;
                        font-size: 0.75em;
                    }
                    .fm-player-col {
                        height: 40%;
                    }
                    .fm-sidebar {
                        height: 60%;
                    }
                    .fm-item {
                        height: 72px;
                        padding: 6px;
                        gap: 10px;
                    }
                    .fm-thumb-wrap {
                        width: 80px;
                        height: 56px;
                    }
                    /* Even smaller tabs for tiny phones */
                    .fm-tab {
                        padding: 10px 8px;
                        font-size: 0.65em;
                    }
                    .fm-menu-content {
                        padding: 12px;
                    }
                }
            </style>
            
            <div class="fm-container animated" id="container" role="application" aria-label="Opening RTSP-Recorder">
                <div class="fm-header" role="banner">
                    <div class="fm-title"><img src="/local/opening_logo4.png" alt="Opening RTSP-Recorder" style="height:50px; vertical-align:middle; background:transparent;"><span style="font-size:0.6em; opacity:0.5; margin-left:10px; border:1px solid #444; padding:2px 6px; border-radius:4px;">BETA v1.3.4</span></div>
                    <div class="fm-toolbar" role="toolbar" aria-label="Filteroptionen">
                        <button class="fm-btn active" id="btn-date" aria-haspopup="true" aria-expanded="false">Letzte 24 Std</button>
                        <button class="fm-btn" id="btn-cams" aria-haspopup="true" aria-expanded="false">Kameras</button>
                        <button class="fm-btn" id="btn-menu" aria-label="Menue oeffnen">Menue</button>
                    </div>
                </div>
                <div class="fm-main" role="main">
                    <div class="fm-player-col">
                        <div class="fm-player-body">
                            <div class="fm-overlay-tl" id="txt-cam" aria-live="polite">Waehle Aufnahme</div>
                            <div class="fm-overlay-tr" id="txt-date">BETA VERSION</div>
                            <div class="fm-frame-info" id="txt-frame-info">00:00:00.000 | 0 FPS | Frame 0</div>
                            <video id="main-video" controls muted playsinline preload="metadata" aria-label="Aufnahme Videoplayer"></video>
                            <div id="video-loading-spinner" class="video-loading-spinner" style="display:none;">
                                <div class="spinner"></div>
                                <div class="loading-text">Video wird geladen...</div>
                            </div>
                            <canvas id="overlay-canvas" aria-hidden="true"></canvas>
                        
                            <!-- Video Controls -->
                            <div class="fm-video-controls" id="video-controls" role="group" aria-label="Video Steuerung">
                                <button class="fm-ctrl-btn" id="btn-download" title="Download" aria-label="Video herunterladen">
                                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>
                                    Download
                                </button>
                                <button class="fm-ctrl-btn danger" id="btn-delete" title="Loeschen" aria-label="Video loeschen">
                                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
                                    Loeschen
                                </button>
                                <button class="fm-ctrl-btn" id="btn-overlay" title="Overlay" aria-label="Erkennungs-Overlay umschalten" aria-pressed="false">
                                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3C4.5 3 1.73 5.11.46 8c1.27 2.89 4.04 5 7.54 5s6.27-2.11 7.54-5C14.27 5.11 11.5 3 8 3zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7z"/><path d="M8 6.5A1.5 1.5 0 1 0 8 9.5a1.5 1.5 0 0 0 0-3z"/></svg>
                                    Overlay
                                </button>
                                <div style="border-left: 1px solid #444; margin: 0 5px;" aria-hidden="true"></div>
                                <button class="fm-ctrl-btn fm-speed-btn" data-speed="0.5" aria-label="Geschwindigkeit 0.5x">0.5x</button>
                                <button class="fm-ctrl-btn fm-speed-btn active" data-speed="1" aria-label="Geschwindigkeit Normal" aria-pressed="true">1x</button>
                                <button class="fm-ctrl-btn fm-speed-btn" data-speed="2" aria-label="Geschwindigkeit 2x">2x</button>
                            </div>
                        </div>
                        <div class="fm-player-footer" id="player-footer" role="region" aria-label="Videooptionen">
                            <div class="fm-footer-left">
                                <label class="fm-toggle">
                                    <input id="footer-overlay" type="checkbox" ${this._overlayEnabled ? 'checked' : ''} aria-describedby="overlay-desc" />
                                    <span id="overlay-desc">Objekte im Video</span>
                                </label>
                                <label class="fm-toggle">
                                    <input id="footer-perf" type="checkbox" ${this._showPerfPanel ? 'checked' : ''} aria-describedby="perf-desc" />
                                    <span id="perf-desc">Leistung anzeigen</span>
                                </label>
                                <!-- Recording status indicator -->
                                <div id="footer-recording-status" style="display:none; margin-left:10px; padding:2px 8px; background:rgba(255,0,0,0.2); border:1px solid #f44336; border-radius:4px; animation:recordPulse 1.5s ease-in-out infinite;">
                                    <span style="color:#f44336; font-size:0.75em;">🔴 Aufnahme läuft...</span>
                                </div>
                                <!-- Analysis status indicator (always visible when running) -->
                                <div id="footer-analysis-status" style="display:none; margin-left:10px; padding:2px 8px; background:rgba(76,175,80,0.2); border:1px solid #4caf50; border-radius:4px;">
                                    <span style="color:#4caf50; font-size:0.75em;">🔄 <span id="analysis-status-text">Analyse läuft...</span></span>
                                </div>
                                <!-- Mobile-only action buttons -->
                                <div class="fm-mobile-actions" id="mobile-actions">
                                    <button class="fm-mobile-btn" id="mobile-download" title="Download">
                                        <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>
                                    </button>
                                    <button class="fm-mobile-btn danger" id="mobile-delete" title="Löschen">
                                        <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
                                    </button>
                                </div>
                            </div>
                            <div class="fm-footer-right" id="footer-perf-panel"></div>
                        </div>
                    </div>
                    <div class="fm-sidebar">
                        <div class="fm-scroll">
                            <div class="fm-ruler" id="ruler"></div>
                            <div class="fm-list" id="list"><div style="padding:20px; color:#888;">Lade Aufnahmen...</div></div>
                        </div>
                    </div>
                </div>
                
                <!-- Popups -->
                <div class="fm-popup" id="pop-cam"></div>
                <div class="fm-popup" id="pop-date">
                    <div class="fm-cal-header"><button class="fm-cal-btn" id="cal-prev" aria-label="Vorheriger Monat">&lt;</button><span id="cal-month-year"></span><button class="fm-cal-btn" id="cal-next" aria-label="Naechster Monat">&gt;</button></div>
                    <div class="fm-cal-grid" id="cal-grid" role="grid" aria-label="Kalender"></div>
                    <div style="padding: 10px; border-top: 1px solid #333; text-align: center;"><button id="btn-clear-date" class="fm-btn-danger" aria-label="Datumsfilter zuruecksetzen">Filter Leeren</button></div>
                </div>
                
                <!-- Menu -->
                <div class="fm-menu-overlay" id="menu-overlay" role="dialog" aria-modal="true" aria-labelledby="menu-title">
                    <div class="fm-menu-card">
                        <div class="fm-menu-header"><div class="fm-menu-title" id="menu-title">Einstellungen</div><div class="fm-menu-close" id="menu-close" role="button" aria-label="Menue schliessen" tabindex="0">X</div></div>
                        <div class="fm-tabs" role="tablist" aria-label="Einstellungskategorien">
                            <div class="fm-tab active" data-tab="general" role="tab" aria-selected="true" tabindex="0">Allgemein</div>
                            <div class="fm-tab" data-tab="storage" role="tab" aria-selected="false" tabindex="-1">Speicher</div>
                            <div class="fm-tab" data-tab="analysis" role="tab" aria-selected="false" tabindex="-1">Analyse</div>
                            <div class="fm-tab" data-tab="percamera" role="tab" aria-selected="false" tabindex="-1">Pro-Kamera</div>
                            <div class="fm-tab" data-tab="people" role="tab" aria-selected="false" tabindex="-1">Personen</div>
                            <div class="fm-tab" data-tab="movement" role="tab" aria-selected="false" tabindex="-1">Bewegung</div>
                            <div class="fm-tab ${this._showPerfTab ? '' : 'hidden'}" data-tab="performance" role="tab" aria-selected="false" tabindex="-1">Leistung</div>
                            <div class="fm-tab" data-tab="delete" role="tab" aria-selected="false" tabindex="-1">Löschen</div>
                        </div>
                        <div class="fm-menu-content" id="menu-content" role="tabpanel"></div>
                    </div>
                </div>
                
                <!-- Delete Confirmation -->
                <div class="fm-confirm-overlay" id="confirm-overlay" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
                    <div class="fm-confirm-card">
                        <div style="font-size:2em;margin-bottom:15px;" aria-hidden="true">!</div>
                        <div style="font-size:1.1em;font-weight:500;" id="confirm-title">Aufnahme loeschen?</div>
                        <div style="color:#888;margin-top:10px;" id="confirm-filename" id="confirm-desc"></div>
                        <div class="fm-confirm-btns">
                            <button class="fm-btn" id="confirm-cancel">Abbrechen</button>
                            <button class="fm-btn-danger" id="confirm-delete" style="padding:10px 20px;">Endgueltig loeschen</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.setupListeners();
        this.updateFooterVisibility();
        this.updateDebugVisibility();  // v1.2.8: Debug-Modus beim Start anwenden
    }

    setupListeners() {
        const root = this.shadowRoot;
        root.querySelector('#btn-date').onclick = (e) => { e.stopPropagation(); this.togglePopup('pop-date'); };
        root.querySelector('#btn-cams').onclick = (e) => { e.stopPropagation(); this.togglePopup('pop-cam'); };
        root.querySelector('#btn-menu').onclick = () => { this.openMenu(); };
        root.querySelector('#menu-close').onclick = () => { this.closeMenu(); };
        root.querySelector('#menu-overlay').onclick = (e) => { if (e.target === root.querySelector('#menu-overlay')) this.closeMenu(); };

        // Video Controls
        root.querySelector('#btn-download').onclick = () => { this.downloadCurrentVideo(); };
        root.querySelector('#btn-delete').onclick = () => { this.showDeleteConfirm(); };
        
        // Mobile Action Buttons (in footer)
        const mobileDownload = root.querySelector('#mobile-download');
        const mobileDelete = root.querySelector('#mobile-delete');
        if (mobileDownload) mobileDownload.onclick = () => { this.downloadCurrentVideo(); };
        if (mobileDelete) mobileDelete.onclick = () => { this.showDeleteConfirm(); };
        
        const overlayBtn = root.querySelector('#btn-overlay');
        if (overlayBtn) {
            overlayBtn.onclick = () => {
                this._overlayEnabled = !this._overlayEnabled;
                this.updateOverlayStates();
                if (this._overlayEnabled) {
                    this.loadDetectionsForCurrentVideo();
                } else {
                    this._stopSmoothingLoop();
                    this.clearOverlay();
                }
            };
        }
        root.querySelector('#confirm-cancel').onclick = () => { this.hideDeleteConfirm(); };
        root.querySelector('#confirm-delete').onclick = () => { this.deleteCurrentVideo(); };
        root.querySelector('#confirm-overlay').onclick = (e) => { if (e.target === root.querySelector('#confirm-overlay')) this.hideDeleteConfirm(); };
        
        // Speed Controls
        root.querySelectorAll('.fm-speed-btn').forEach(btn => {
            btn.onclick = () => {
                const speed = parseFloat(btn.dataset.speed);
                root.querySelector('#main-video').playbackRate = speed;
                root.querySelectorAll('.fm-speed-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            };
        });

        root.querySelectorAll('.fm-tab').forEach(t => {
            t.onclick = () => {
                root.querySelectorAll('.fm-tab').forEach(x => x.classList.remove('active'));
                t.classList.add('active');
                this._activeTab = t.dataset.tab;
                this.renderMenuContent();
                if (this._activeTab === "analysis" || this._activeTab === "performance") {
                    this.startStatsPolling();
                    this.refreshAnalysisOverview();
                    // v1.1.0: Check if batch analysis is running when switching to analysis tab
                    // Delay to ensure DOM is updated after renderMenuContent
                    setTimeout(() => {
                        this._checkAndRestoreProgress();
                        this._checkAndRestoreSingleProgress();
                    }, 100);
                }
            }
        });

        root.querySelector('#cal-prev').onclick = (e) => { e.stopPropagation(); this._calMonth--; if (this._calMonth < 0) { this._calMonth = 11; this._calYear--; } this.renderCalendar(); };
        root.querySelector('#cal-next').onclick = (e) => { e.stopPropagation(); this._calMonth++; if (this._calMonth > 11) { this._calMonth = 0; this._calYear++; } this.renderCalendar(); };
        root.querySelector('#btn-clear-date').onclick = () => { this._selectedDate = null; this.updateDateLabel(); this.togglePopup(); this.renderCalendar(); };

        this.onclick = () => { this.togglePopup(); };

        const video = root.querySelector('#main-video');
        if (video) {
            // v1.1.0k: Use debounced overlay update for smoother rendering
            video.addEventListener('timeupdate', () => this._scheduleOverlayUpdate());
            video.addEventListener('loadedmetadata', () => this.resizeOverlay());
            // v1.1.0k: Also update on seeking for immediate feedback
            video.addEventListener('seeked', () => this.drawOverlay());
        }

        const footerOverlay = root.querySelector('#footer-overlay');
        if (footerOverlay) {
            footerOverlay.onchange = () => {
                this._overlayEnabled = footerOverlay.checked;
                this.updateOverlayStates();
                if (this._overlayEnabled) {
                    this.loadDetectionsForCurrentVideo();
                } else {
                    this._stopSmoothingLoop();
                    this.clearOverlay();
                }
            };
        }

        const footerPerf = root.querySelector('#footer-perf');
        if (footerPerf) {
            footerPerf.onchange = () => {
                this._showPerfPanel = footerPerf.checked;
                this.updatePerfFooter();
            };
        }

        this.updateOverlayStates();
        this.updatePerfFooter();
    }

    togglePopup(id) {
        const root = this.shadowRoot;
        ['pop-cam', 'pop-date'].forEach(pid => {
            const el = root.querySelector('#' + pid);
            if (el) el.style.display = (pid === id && el.style.display !== 'block') ? 'block' : 'none';
        });
        if (id === 'pop-cam') {
            const container = root.querySelector('#pop-cam');
            // DYNAMIC CAMERA LIST
            let cams = ['Alle'];
            if (this._events) {
                const unique = [...new Set(this._events.map(e => e.cam))].sort();
                cams = cams.concat(unique);
            }

            container.innerHTML = cams.map(c => {
                const displayName = c === 'Alle' ? 'Alle' : c.replace(/_/g, ' ');
                return `<div class="fm-popup-item ${this._selectedCam === c ? 'active' : ''}" id="cam-${this._escapeHtml(c)}">${this._escapeHtml(displayName)}</div>`;
            }).join('');

            cams.forEach(c => {
                const el = container.querySelector('#cam-' + c.replace(/ /g, '\\ ').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
                if (el) el.onclick = () => { this._selectedCam = c; this.updateView(); this.togglePopup(); };
            });
        }
    }

    updateDateLabel() {
        const btn = this.shadowRoot.querySelector('#btn-date');
        if (this._selectedDate) { btn.classList.remove('active'); btn.innerText = `Datum: ${this._selectedDate}`; }
        else { btn.classList.add('active'); btn.innerText = 'Letzte 24 Std'; }
        this.updateView();
    }

    openMenu() {
        this.shadowRoot.querySelector('#menu-overlay').classList.add('open');
        this.renderMenuContent();
        if (this._activeTab === "analysis" || this._activeTab === "performance") {
            this.startStatsPolling();
            this.refreshAnalysisOverview();
        }
    }
    closeMenu() { this.shadowRoot.querySelector('#menu-overlay').classList.remove('open'); }

    renderMenuContent() {
        const container = this.shadowRoot.querySelector('#menu-content');
        const perfTab = this.shadowRoot.querySelector('.fm-tab[data-tab="performance"]');
        if (perfTab) {
            perfTab.classList.toggle('hidden', !this._showPerfTab);
        }
        if (!this._showPerfTab && this._activeTab === 'performance') {
            this._activeTab = 'general';
        }
        this.shadowRoot.querySelectorAll('.fm-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === this._activeTab);
        });
        if (this._activeTab === 'general') {
            container.innerHTML = `
                <div style="padding:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:15px;border-bottom:1px solid #333;">
                        <div>
                            <span style="font-weight:500;">Kiosk Modus</span>
                            <div style="font-size:0.8em;color:#888;margin-top:4px;">Vollbild ohne Browser-UI</div>
                        </div>
                        <input type="checkbox" id="chk-kiosk" ${this._kioskActive ? 'checked' : ''} style="transform:scale(1.3);cursor:pointer;">
                    </div>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div>
                            <span style="font-weight:500;">Animationen</span>
                            <div style="font-size:0.8em;color:#888;margin-top:4px;">Sanfte Uebergaenge und Hover-Effekte</div>
                        </div>
                        <input type="checkbox" id="chk-animations" ${this._animationsEnabled ? 'checked' : ''} style="transform:scale(1.3);cursor:pointer;">
                    </div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding-top:15px;border-top:1px solid #333;">
                        <div>
                            <span style="font-weight:500;">Footer anzeigen</span>
                            <div style="font-size:0.8em;color:#888;margin-top:4px;">Zeigt die Footer-Leiste unter dem Video</div>
                        </div>
                        <input type="checkbox" id="chk-footer" ${this._showFooter ? 'checked' : ''} style="transform:scale(1.3);cursor:pointer;">
                    </div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding-top:15px;border-top:1px solid #333;">
                        <div>
                            <span style="font-weight:500;">Debug-Modus</span>
                            <div style="font-size:0.8em;color:#888;margin-top:4px;">Zeigt FPS, Frame-Info und Leistungsoptionen</div>
                        </div>
                        <input type="checkbox" id="chk-debug" ${this._debugMode ? 'checked' : ''} style="transform:scale(1.3);cursor:pointer;">
                    </div>
                    <div id="pc-global-settings" style="margin-top:10px;">Lade Einstellungen…</div>
                </div>
            `;
            container.querySelector('#chk-kiosk').onchange = () => {
                this._kioskActive = !this._kioskActive;
                this.shadowRoot.querySelector('#container').classList.toggle('kiosk', this._kioskActive);
            };
            container.querySelector('#chk-animations').onchange = () => {
                this._animationsEnabled = !this._animationsEnabled;
                this.shadowRoot.querySelector('#container').classList.toggle('animated', this._animationsEnabled);
            };
            container.querySelector('#chk-footer').onchange = () => {
                this._showFooter = !this._showFooter;
                this.updateFooterVisibility();
                this.saveLocalSettings();
            };
            container.querySelector('#chk-debug').onchange = () => {
                this._debugMode = !this._debugMode;
                this.updateDebugVisibility();
                this.saveLocalSettings();
            };
            this._pcInjectGlobalSettings(container);
        } else if (this._activeTab === 'storage') {
            // Storage Tab
            this.renderStorageTab(container);
        } else if (this._activeTab === 'people') {
            // People Tab
            this.renderPeopleTab(container);
        } else if (this._activeTab === 'percamera') {
            this.renderPerCameraTab(container);
        } else if (this._activeTab === 'delete') {
            this.renderDeleteTab(container);
        } else if (this._activeTab === 'movement') {
            // Movement Profile Tab
            this.renderMovementTab(container);
        } else if (this._activeTab === 'performance') {
            this.renderPerformanceTab(container);
        } else {
            // Analysis Tab
            this.renderAnalysisTab(container);
        }
    }

    updateFooterVisibility() {
        const footer = this.shadowRoot.querySelector('#player-footer');
        if (!footer) return;
        footer.style.display = this._showFooter ? 'flex' : 'none';
    }

    // v1.2.8: Debug-Modus Sichtbarkeit aktualisieren
    updateDebugVisibility() {
        const root = this.shadowRoot;
        if (!root) return;
        
        // FPS/Frame-Info anzeigen (oben rechts im Video)
        const frameInfo = root.querySelector('#txt-frame-info');
        if (frameInfo) {
            frameInfo.style.display = this._debugMode ? 'block' : 'none';
        }
        
        // "Leistung anzeigen" Checkbox Label
        const perfToggle = root.querySelector('#footer-perf')?.closest('.fm-toggle');
        if (perfToggle) {
            perfToggle.style.display = this._debugMode ? 'flex' : 'none';
        }
        
        // Performance Panel Sichtbarkeit
        const perfPanel = root.querySelector('#footer-perf-panel');
        if (!this._debugMode) {
            // Debug aus: Panel ausblenden und Checkbox zurücksetzen
            if (perfPanel) {
                perfPanel.style.display = 'none';
            }
            this._showPerfPanel = false;
            const perfCheckbox = root.querySelector('#footer-perf');
            if (perfCheckbox) {
                perfCheckbox.checked = false;
            }
        } else {
            // Debug an: Panel-Display zurücksetzen (Inhalt wird von updatePerfFooter gesteuert)
            if (perfPanel) {
                perfPanel.style.display = '';
            }
        }
    }

    loadLocalSettings() {
        try {
            const raw = localStorage.getItem(this._settingsKey);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (typeof data.showFooter === 'boolean') {
                this._showFooter = data.showFooter;
            }
            // v1.2.8: Debug-Modus aus LocalStorage laden
            if (typeof data.debugMode === 'boolean') {
                this._debugMode = data.debugMode;
            }
        } catch (e) {
            // ignore
        }
    }

    saveLocalSettings() {
        try {
            const data = {
                showFooter: this._showFooter,
                debugMode: this._debugMode,  // v1.2.8: Debug-Modus speichern
            };
            localStorage.setItem(this._settingsKey, JSON.stringify(data));
        } catch (e) {
            // ignore
        }
    }

    renderPerformanceTab(container) {
        const live = this._liveStats || {};
        const stats = this._detectorStats || {};
        const tracker = stats.inference_stats || {};
        const devices = stats.devices || [];
        const hasCoralUsb = devices.includes('coral_usb');
        const history = this._statsHistory || [];
        // v1.2.3: Prefer HA host stats, fallback to detector stats
        const hostStats = stats.system_stats_ha || {};
        const sysStats = stats.system_stats || {};

        // Helper for gauge-style cards
        const gaugeCard = (label, value, unit, color, max = 100) => {
            const pct = Math.min(100, Math.max(0, (value / max) * 100));
            return `
                <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:16px; min-width:160px; flex:1;">
                    <div style="font-size:0.85em; color:#888; margin-bottom:8px;">${label}</div>
                    <div style="font-size:1.8em; font-weight:600; color:${color}; margin-bottom:10px;">${value}${unit}</div>
                    <div style="background:#333; height:6px; border-radius:3px; overflow:hidden;">
                        <div style="background:${color}; height:100%; width:${pct}%; transition:width 0.3s;"></div>
                    </div>
                </div>
            `;
        };

        // System stats - prefer detector stats, fallback to HA sensors
        const cpu = hostStats.cpu ?? sysStats.cpu_percent ?? live.cpu?.state ?? 0;
        const cpuColor = cpu > 80 ? '#f44336' : cpu > 50 ? '#ff9800' : '#4caf50';
        const mem = hostStats.memory ?? sysStats.memory_percent ?? live.memory?.state ?? 0;
        const memColor = mem > 80 ? '#f44336' : mem > 60 ? '#ff9800' : '#4caf50';

        // Coral stats - v1.2.2: Fixed jumping status by using coral_inferences instead of last_device
        const coralPct = tracker.recent_coral_pct ?? tracker.coral_usage_pct ?? 0;
        const coralActive = tracker.coral_inferences > 0;  // Stable: true if ever used Coral
        const lastDevice = tracker.last_device || 'keine';
        const avgMs = tracker.avg_inference_ms || 0;
        const totalInf = tracker.total_inferences || 0;
        const hasInf = totalInf > 0;
        const coralColor = hasInf
            ? (coralPct > 50 ? '#4caf50' : coralPct > 0 ? '#ff9800' : '#666')
            : '#666';
        const coralDisplay = hasInf ? `${Math.round(coralPct)}%` : '-';
        // Device display
        const deviceDisplay = hasInf ? (lastDevice === 'coral_usb' ? 'Coral USB' : 'CPU') : '-';
        const deviceColor = hasInf ? (lastDevice === 'coral_usb' ? '#4caf50' : '#ff9800') : '#666';

        // v1.2.3: TPU Load - Echtzeit: 0% wenn keine Inferenz in letzten 3 Sekunden
        const ipm = tracker.inferences_per_minute ?? 0;
        const fallbackSecs = this._lastInferenceAt ? (Date.now() - this._lastInferenceAt) / 1000 : -1;
        const secsSinceLastInf = tracker.seconds_since_last_inference ?? fallbackSecs;
        const hasRealtime = secsSinceLastInf >= 0;
        const isActive = hasRealtime ? secsSinceLastInf < 3 : ipm > 0;
        const tpuLoadVal = isActive ? Math.min(100, Math.round((ipm * avgMs) / 600)) : 0;
        const tpuLoadDisplay = hasInf ? `${tpuLoadVal}%` : '-';
        const inferenceMsDisplay = hasInf ? (isActive && avgMs > 0 ? `${avgMs.toFixed(0)}ms` : '0ms') : '-';
        const tpuLoadColor = !hasInf ? '#666' : tpuLoadVal > 25 ? '#f44336' : tpuLoadVal > 5 ? '#ff9800' : '#4caf50';

        // Mini sparkline from history
        let sparklineSvg = '';
        if (history.length > 1) {
            const w = 200, h = 40;
            const maxCpu = Math.max(...history.map(h => h.cpu), 1);
            const points = history.map((h, i) => {
                const x = (i / (history.length - 1)) * w;
                const y = h - (h.cpu / maxCpu) * (h - 5);
                return `${x},${y}`;
            }).join(' ');
            sparklineSvg = `
                <svg width="${w}" height="${h}" style="display:block;">
                    <polyline points="${points}" fill="none" stroke="#03a9f4" stroke-width="2"/>
                </svg>
            `;
        }

        container.innerHTML = `
            <div style="padding:15px;">
                <!-- Live System Stats -->
                <div style="margin-bottom:20px;">
                    <div style="font-weight:500; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                        <span style="color:#4caf50;">OK</span> Live System
                    </div>
                    <div style="display:flex; gap:12px; flex-wrap:wrap;">
                        ${gaugeCard('CPU Auslastung', cpu.toFixed(1), '%', cpuColor)}
                        ${gaugeCard('RAM Auslastung', mem.toFixed(1), '%', memColor)}
                    </div>
                </div>

                <!-- Detector Stats -->
                <div style="margin-bottom:20px; padding-top:15px; border-top:1px solid #333;">
                    <div style="font-weight:500; margin-bottom:12px;">Objekt-Erkennung</div>
                    <div style="display:flex; gap:12px; flex-wrap:wrap;">
                        <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:16px; min-width:160px; flex:1;">
                            <div style="font-size:0.85em; color:#888; margin-bottom:8px;">Coral USB</div>
                            <div style="font-size:1.4em; font-weight:600; color:${hasCoralUsb ? (coralActive ? '#4caf50' : '#ff9800') : '#666'};">
                                ${hasCoralUsb ? (coralActive ? 'Aktiv' : 'Bereit') : 'Nicht verbunden'}
                            </div>
                        </div>
                        <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:16px; min-width:160px; flex:1;">
                            <div style="font-size:0.85em; color:#888; margin-bottom:8px;">Letztes Device</div>
                            <div style="font-size:1.4em; font-weight:600; color:${deviceColor};">
                                ${deviceDisplay}
                            </div>
                        </div>
                        ${hasCoralUsb ? `
                            <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:16px; min-width:160px; flex:1;">
                                <div style="font-size:0.85em; color:#888; margin-bottom:8px;">Coral Nutzung</div>
                                <div style="font-size:1.8em; font-weight:600; color:${coralColor};">
                                    ${coralDisplay}
                                </div>
                            </div>
                            <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:16px; min-width:160px; flex:1;" title="Wie viel der TPU-Zeit ist mit Inferenzen belegt (60s Fenster)">
                                <div style="font-size:0.85em; color:#888; margin-bottom:8px;">TPU Last</div>
                                <div style="font-size:1.8em; font-weight:600; color:${tpuLoadColor};">
                                    ${tpuLoadDisplay}
                                </div>
                            </div>
                        ` : ''}
                        <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:16px; min-width:160px; flex:1;">
                            <div style="font-size:0.85em; color:#888; margin-bottom:8px;">Inferenzzeit</div>
                            <div style="font-size:1.8em; font-weight:600; color:#03a9f4;">
                                ${inferenceMsDisplay}
                            </div>
                        </div>
                        <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:16px; min-width:160px; flex:1;">
                            <div style="font-size:0.85em; color:#888; margin-bottom:8px;">Inferenzen gesamt</div>
                            <div style="font-size:1.8em; font-weight:600; color:#03a9f4;">${totalInf}</div>
                        </div>
                    </div>
                    ${!hasInf ? `
                        <div style="margin-top:10px; color:#888; font-size:0.9em;">
                            Coral-Nutzung wird nur bei aktiver Live-Erkennung oder neuer Videoanalyse gezaehlt.
                        </div>
                    ` : ''}
                    <div style="margin-top:12px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                        <button id="test-inference-btn" style="background:#03a9f4; color:#fff; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-size:0.95em;">
                            Test-Inferenz starten
                        </button>
                        <button id="reset-stats-btn" style="background:#ff9800; color:#fff; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-size:0.95em;">
                            Statistik zurücksetzen
                        </button>
                        <span id="test-inference-status" style="margin-left:10px; color:#888; font-size:0.9em;"></span>
                    </div>
                </div>

                <!-- CPU History Graph -->
                ${history.length > 5 ? `
                    <div style="padding-top:15px; border-top:1px solid #333;">
                        <div style="font-weight:500; margin-bottom:12px;">CPU Verlauf (letzte ${history.length} Messungen)</div>
                        <div style="background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:10px;">
                            ${sparklineSvg}
                        </div>
                    </div>
                ` : `
                    <div style="padding-top:15px; border-top:1px solid #333; color:#666; font-size:0.9em;">
                        CPU Verlauf wird nach einigen Messungen angezeigt...
                    </div>
                `}

                <!-- Info -->
                <div style="margin-top:20px; padding:12px; background:#222; border-radius:8px; color:#888; font-size:0.85em;">
                    <strong>Hinweis:</strong> Die Statistiken werden alle 5 Sekunden aktualisiert.<br>
                    <strong>Coral Nutzung:</strong> Anteil der Inferenzen auf Coral vs CPU.<br>
                    <strong>TPU Last:</strong> Berechnet aus (Inferenz-Zeit / 60s) - zeigt wie viel der TPU-Kapazitaet genutzt wird.
                </div>
            </div>
        `;
        
        // Attach test inference button handler
        setTimeout(() => {
            const btn = this.shadowRoot.querySelector('#test-inference-btn');
            if (btn) {
                btn.onclick = () => this.runTestInference();
            }
            const resetBtn = this.shadowRoot.querySelector('#reset-stats-btn');
            if (resetBtn) {
                resetBtn.onclick = () => this.resetDetectorStats();
            }
        }, 50);
    }

    async runTestInference() {
        const btn = this.shadowRoot.querySelector('#test-inference-btn');
        const status = this.shadowRoot.querySelector('#test-inference-status');
        if (btn) btn.disabled = true;
        if (status) status.textContent = 'Laeuft...';
        
        try {
            const result = await this._hass.callWS({ type: 'rtsp_recorder/test_inference' });
            console.log('[RTSP-Recorder] Test Inference Result:', result);
            if (result.success) {
                if (status) { status.textContent = '✓ ' + result.device + ' (' + result.duration_ms + 'ms)'; status.style.color = '#4caf50'; }
                // Refresh stats after successful test
                await this.fetchDetectorStats();
            } else {
                if (status) { status.textContent = 'Fehler: ' + result.message; status.style.color = '#f44336'; }
            }
        } catch (e) {
            console.error('[RTSP-Recorder] Test inference failed:', e);
            if (status) { status.textContent = 'Fehler: ' + (e.message || e); status.style.color = '#f44336'; }
        }
        
        if (btn) btn.disabled = false;
    }

    async resetDetectorStats() {
        const btn = this.shadowRoot.querySelector('#reset-stats-btn');
        const status = this.shadowRoot.querySelector('#test-inference-status');
        if (btn) btn.disabled = true;
        if (status) status.textContent = 'Setze zurück...';
        
        try {
            const result = await this._hass.callWS({ type: 'rtsp_recorder/reset_detector_stats' });
            console.log('[RTSP-Recorder] Reset Stats Result:', result);
            if (result.success) {
                if (status) { status.textContent = '✓ Statistik zurückgesetzt'; status.style.color = '#4caf50'; }
                // Refresh stats after reset
                await this.fetchDetectorStats();
            } else {
                if (status) { status.textContent = 'Fehler: ' + result.message; status.style.color = '#f44336'; }
            }
        } catch (e) {
            console.error('[RTSP-Recorder] Reset stats failed:', e);
            if (status) { status.textContent = 'Fehler: ' + (e.message || e); status.style.color = '#f44336'; }
        }
        
        if (btn) btn.disabled = false;
    }

    renderAnalysisTab(container) {
        // v1.1.0 Fix: Also use devices from detector stats if available
        let deviceOptions = (this._analysisDeviceOptions && this._analysisDeviceOptions.length)
            ? this._analysisDeviceOptions
            : null;
        
        // Fallback to detector stats devices
        if (!deviceOptions && this._detectorStats && this._detectorStats.devices && this._detectorStats.devices.length) {
            deviceOptions = this._detectorStats.devices.map(d => ({ 
                value: d, 
                label: d === 'coral_usb' ? 'Coral USB' : d.toUpperCase() 
            }));
        }
        
        // Final fallback to CPU only
        if (!deviceOptions || !deviceOptions.length) {
            deviceOptions = [{ value: 'cpu', label: 'CPU' }];
        }

        // Standard-Profile fuer schnelle Auswahl
        const standardProfiles = [
            { name: 'Alle', objects: this._analysisObjects, isCamera: false },
            { name: 'Personen', objects: ['person', 'face'], isCamera: false },
            { name: 'Tiere', objects: ['cat', 'dog', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'], isCamera: false },
            { name: 'Fahrzeuge', objects: ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'boat', 'airplane', 'train'], isCamera: false },
            { name: 'Pakete', objects: ['package', 'suitcase', 'backpack', 'handbag'], isCamera: false },
        ];

        // v1.1.0: Kamera-spezifische Profile aus den Einstellungen
        const cameraProfiles = [];
        if (this._cameraObjectsMap && Object.keys(this._cameraObjectsMap).length > 0) {
            for (const [camName, objects] of Object.entries(this._cameraObjectsMap)) {
                if (objects && objects.length > 0) {
                    // Kameraname lesbar machen (Unterstriche durch Leerzeichen ersetzen)
                    const displayName = camName.replace(/_/g, ' ');
                    cameraProfiles.push({ name: displayName, objects: objects, isCamera: true });
                }
            }
        }

        // Alle Profile kombinieren
        const allProfiles = [...standardProfiles, ...cameraProfiles];

        const profileButtons = allProfiles.map(p => {
            const available = p.objects.filter(o => this._analysisObjects.includes(o));
            if (available.length === 0) return '';
            const bgColor = p.isCamera ? '#1a3a4a' : '#333';
            const borderColor = p.isCamera ? '#2980b9' : '#444';
            const icon = p.isCamera ? '📷 ' : '';
            return `<button class="fm-profile-btn" data-objects="${available.join(',')}" style="padding:6px 12px; background:${bgColor}; color:#eee; border:1px solid ${borderColor}; border-radius:6px; cursor:pointer; font-size:0.85em;">${icon}${p.name}</button>`;
        }).filter(Boolean).join('');

        const objectCheckboxes = this._analysisObjects.map(obj => {
            const checked = this._analysisSelected.has(obj) ? 'checked' : '';
            return `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 0;">
                    <input type="checkbox" class="fm-obj" value="${obj}" ${checked} />
                    <span>${obj}</span>
                </label>
            `;
        }).join('');

        const deviceSelect = deviceOptions.map(d => {
            const selected = this._analysisDevice === d.value ? 'selected' : '';
            return `<option value="${d.value}" ${selected}>${d.label}</option>`;
        }).join('');

        const overview = this._analysisOverview || { items: [], stats: {} };
        const items = overview.items || [];
        const stats = overview.stats || {};
        const perf = this._perfSensors || {};
                const perfCard = (label, sensor) => {
                    if (!sensor) {
                        return `
                            <div style="background:#222; padding:10px 12px; border-radius:8px; min-width:140px;">
                                <div style="font-size:0.9em; color:#888;">${label}</div>
                                <div style="font-size:1.1em; font-weight:600; color:#666;">n/a</div>
                            </div>
                        `;
                    }
                    const value = sensor.state ?? 'n/a';
                    const unit = sensor.unit ? ` ${sensor.unit}` : '';
                    const name = this._escapeHtml(sensor.name || label);
                    return `
                        <div style="background:#222; padding:10px 12px; border-radius:8px; min-width:140px;">
                            <div style="font-size:0.8em; color:#888;">${name}</div>
                            <div style="font-size:1.1em; font-weight:600; color:var(--primary-color);">${this._escapeHtml(value)}${this._escapeHtml(unit)}</div>
                        </div>
                    `;
                };
        const byDevice = stats.by_device || {};
        const self = this; // Reference for escapeHtml in map
        const deviceBreakdown = Object.entries(byDevice)
            .sort((a, b) => b[1] - a[1])
            .map(([dev, count]) => `
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #333;">
                    <span>${self._escapeHtml(dev)}</span>
                    <span style="color:var(--primary-color);font-weight:500;">${count}</span>
                </div>
            `).join('');

        const itemsHtml = items.map(item => {
            const name = this._escapeHtml((item.video_path || '').split('/').pop() || 'unknown');
            const created = this._escapeHtml(item.created_utc || '');
            const device = this._escapeHtml(item.device || 'cpu');
            const duration = item.duration_sec ? `${item.duration_sec}s` : '';
            return `
                <div style="padding:8px 0;border-bottom:1px solid #333;">
                    <div style="font-weight:500;">${name}</div>
                    <div style="font-size:0.8em;color:#888;">${created} · ${device} ${duration ? '· ' + duration : ''}</div>
                </div>
            `;
        }).join('');

        // Pagination UI
        const totalPages = this._analysisTotalPages || 1;
        const currentPage = this._analysisPage || 1;
        const totalItems = this._analysisTotal || 0;
        
        const buildPaginationButtons = () => {
            if (totalPages <= 1) return '';
            
            let buttons = [];
            
            // Previous button
            buttons.push(`<button class="pagination-btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} style="padding:6px 10px; background:#333; color:${currentPage <= 1 ? '#666' : '#eee'}; border:1px solid #444; border-radius:4px; cursor:${currentPage <= 1 ? 'not-allowed' : 'pointer'};">◀</button>`);
            
            // Page numbers
            const maxVisible = 5;
            let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
            let endPage = Math.min(totalPages, startPage + maxVisible - 1);
            
            if (endPage - startPage < maxVisible - 1) {
                startPage = Math.max(1, endPage - maxVisible + 1);
            }
            
            if (startPage > 1) {
                buttons.push(`<button class="pagination-btn" data-page="1" style="padding:6px 10px; background:#333; color:#eee; border:1px solid #444; border-radius:4px; cursor:pointer;">1</button>`);
                if (startPage > 2) {
                    buttons.push(`<span style="color:#666;">...</span>`);
                }
            }
            
            for (let i = startPage; i <= endPage; i++) {
                const isActive = i === currentPage;
                buttons.push(`<button class="pagination-btn" data-page="${i}" style="padding:6px 10px; background:${isActive ? 'var(--primary-color)' : '#333'}; color:${isActive ? '#000' : '#eee'}; border:1px solid ${isActive ? 'var(--primary-color)' : '#444'}; border-radius:4px; cursor:pointer; font-weight:${isActive ? '600' : '400'};">${i}</button>`);
            }
            
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) {
                    buttons.push(`<span style="color:#666;">...</span>`);
                }
                buttons.push(`<button class="pagination-btn" data-page="${totalPages}" style="padding:6px 10px; background:#333; color:#eee; border:1px solid #444; border-radius:4px; cursor:pointer;">${totalPages}</button>`);
            }
            
            // Next button
            buttons.push(`<button class="pagination-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} style="padding:6px 10px; background:#333; color:${currentPage >= totalPages ? '#666' : '#eee'}; border:1px solid #444; border-radius:4px; cursor:${currentPage >= totalPages ? 'not-allowed' : 'pointer'};">▶</button>`);
            
            return buttons.join('');
        };
        
        const paginationHtml = totalPages > 1 ? `
            <div style="display:flex; align-items:center; justify-content:center; gap:6px; margin-top:12px; flex-wrap:wrap;">
                ${buildPaginationButtons()}
            </div>
            <div style="text-align:center; margin-top:8px; font-size:0.8em; color:#888;">
                Seite ${currentPage} von ${totalPages} (${totalItems} Analysen gesamt)
            </div>
        ` : (totalItems > 0 ? `<div style="text-align:center; margin-top:8px; font-size:0.8em; color:#888;">${totalItems} Analysen</div>` : '');

        const historyHtml = items.slice(0, 20).map(item => {
            const created = item.created_utc || '';
            const device = item.device || 'cpu';
            const perf = item.perf_snapshot || {};
            const cpu = perf.cpu && perf.cpu.state != null ? `${perf.cpu.state}${perf.cpu.unit || ''}` : 'n/a';
            const igpu = perf.igpu && perf.igpu.state != null ? `${perf.igpu.state}${perf.igpu.unit || ''}` : 'n/a';
            const coral = perf.coral && perf.coral.state != null ? `${perf.coral.state}${perf.coral.unit || ''}` : 'n/a';
            return `
                <div style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid #333;">
                    <div style="min-width:120px; color:#aaa;">${created}</div>
                    <div style="flex:1;">${device}</div>
                    <div style="display:flex; gap:10px; color:#888; font-size:0.85em;">
                        <span>CPU ${cpu}</span>
                        <span>iGPU ${igpu}</span>
                        <span>Coral ${coral}</span>
                    </div>
                </div>
            `;
        }).join('');

        const overviewHtml = this._analysisLoading
            ? '<div style="color:#888;">Lade Analyseuebersicht...</div>'
            : (items.length ? itemsHtml : '<div style="color:#888;">Keine Analysen gefunden</div>');

        container.innerHTML = `
            <div style="padding:10px;">
                <div style="background:rgba(3,169,244,0.14);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:0.88em;line-height:1.4;">🌐 <b>Globale Standardwerte</b> — gelten für <b>ALLE</b> Kameras (Standard). Eigene Werte je Kamera: Tab <b>„Pro-Kamera"</b>.</div>
                <div style="margin-bottom:10px; font-weight:500;">Objekte auswaehlen</div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">
                    ${profileButtons}
                    <button id="btn-select-none" style="padding:6px 12px; background:#222; color:#888; border:1px solid #333; border-radius:6px; cursor:pointer; font-size:0.85em;">Keine</button>
                </div>
                <div style="max-height:180px; overflow:auto; border:1px solid #333; border-radius:8px; padding:10px;">
                    ${objectCheckboxes}
                </div>
                <div style="margin-top:15px;">
                    <div style="margin-bottom:6px; font-weight:500;">Hardware</div>
                    <select id="analysis-device" style="width:100%; padding:8px; background:#222; color:#eee; border:1px solid #333; border-radius:6px;">
                        ${deviceSelect}
                    </select>
                </div>
                <button class="fm-btn" id="btn-analyze" style="margin-top:20px; width:100%; justify-content:center;">
                    🔍 Analyse aktuelle Aufnahme
                </button>
                <!-- Single Video Progress Container -->
                <div id="single-analysis-progress" style="display:none; margin-top:8px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div class="loading-spinner" style="width:16px; height:16px; border:2px solid #333; border-top-color:#2196f3; border-radius:50%; animation:spin 1s linear infinite;"></div>
                        <span id="single-analysis-text" style="font-size:0.85em; color:#aaa;">Analyse läuft...</span>
                    </div>
                </div>
                <style>
                    @keyframes spin { to { transform: rotate(360deg); } }
                </style>
                <label style="display:flex;align-items:center;gap:8px;margin-top:12px;">
                    <input id="analysis-overlay" type="checkbox" ${this._overlayEnabled ? 'checked' : ''} />
                    <span>Objekte im Video anzeigen</span>
                </label>
                <div style="margin-top:20px; border-top:1px solid #333; padding-top:15px;">
                    <div style="font-weight:500; margin-bottom:10px;">Alle Aufnahmen analysieren</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                        <label style="display:flex;flex-direction:column;gap:6px;">
                            <span style="font-size:0.8em;color:#888;">Zeitraum (Tage)</span>
                            <input id="analysis-days" type="number" min="0" value="1" style="padding:8px; background:#222; color:#eee; border:1px solid #333; border-radius:6px;" />
                        </label>
                        <label style="display:flex;flex-direction:column;gap:6px;">
                            <span style="font-size:0.8em;color:#888;">Limit</span>
                            <input id="analysis-limit" type="number" min="0" value="50" style="padding:8px; background:#222; color:#eee; border:1px solid #333; border-radius:6px;" />
                        </label>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
                        <input id="analysis-skip" type="checkbox" checked />
                        <span>Nur neue Dateien</span>
                    </label>
                    <button class="fm-btn" id="btn-analyze-all" style="margin-top:12px; width:100%; justify-content:center;">
                        Alle Aufnahmen analysieren
                    </button>
                    <!-- Progress Bar Container -->
                    <div id="analysis-progress-container" style="display:none; margin-top:12px;">
                        <div style="background:#333; border-radius:6px; overflow:hidden; height:20px;">
                            <div id="analysis-progress-bar" style="background:#2196f3; height:100%; width:0%; transition:width 0.3s ease;"></div>
                        </div>
                        <div id="analysis-progress-text" style="font-size:0.85em; color:#aaa; margin-top:6px; text-align:center;">
                            Fortschritt wird geladen...
                        </div>
                    </div>
                </div>
                <div style="margin-top:20px; border-top:1px solid #333; padding-top:15px;">
                    <div style="font-weight:500; margin-bottom:10px;">Analyseuebersicht</div>
                    ${overviewHtml}
                    ${paginationHtml}
                </div>
                <div style="margin-top:20px; border-top:1px solid #333; padding-top:15px;">
                    <div style="font-weight:500; margin-bottom:10px;">Verlauf (Geraet & Leistung)</div>
                    ${this._analysisLoading ? '<div style="color:#888;">Lade Verlauf...</div>' : (historyHtml || '<div style="color:#888;">Keine Daten</div>')}
                </div>
                <div style="margin-top:20px; border-top:1px solid #333; padding-top:15px;">
                    <div style="font-weight:500; margin-bottom:10px;">Leistungsuebersicht</div>
                    <div style="display:flex; gap:10px; flex-wrap:wrap;">
                        <div style="background:#222; padding:10px 12px; border-radius:8px; min-width:120px;">
                            <div style="font-size:1.2em; font-weight:600; color:var(--primary-color);">${stats.total || 0}</div>
                            <div style="font-size:0.75em;color:#888;">Analysen</div>
                        </div>
                        <div style="background:#222; padding:10px 12px; border-radius:8px; min-width:120px;">
                            <div style="font-size:1.2em; font-weight:600; color:var(--primary-color);">${stats.avg_duration_sec || 0}s</div>
                            <div style="font-size:0.75em;color:#888;">Dauer</div>
                        </div>
                        <div style="background:#222; padding:10px 12px; border-radius:8px; min-width:120px;">
                            <div style="font-size:1.2em; font-weight:600; color:var(--primary-color);">${stats.avg_frame_count || 0}</div>
                            <div style="font-size:0.75em;color:#888;">Frames</div>
                        </div>
                    </div>
                    <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
                        ${perfCard('CPU', perf.cpu)}
                        ${perfCard('iGPU', perf.igpu)}
                        ${perfCard('Coral', perf.coral)}
                    </div>
                    <div style="margin-top:12px;">
                        <div style="font-size:0.8em;color:#888;margin-bottom:6px;">Geraete-Nutzung</div>
                        ${deviceBreakdown || '<div style="color:#888;">Keine Daten</div>'}
                    </div>
                </div>
            </div>
        `;

        // Profil-Buttons Handler
        container.querySelectorAll('.fm-profile-btn').forEach(btn => {
            btn.onclick = () => {
                const objects = btn.getAttribute('data-objects').split(',');
                this._analysisSelected = new Set(objects);
                container.querySelectorAll('.fm-obj').forEach(cb => {
                    cb.checked = this._analysisSelected.has(cb.value);
                });
                // Highlight active button
                container.querySelectorAll('.fm-profile-btn').forEach(b => {
                    b.style.background = '#333';
                    b.style.borderColor = '#444';
                });
                btn.style.background = 'var(--primary-color)';
                btn.style.borderColor = 'var(--primary-color)';
            };
        });

        // "Keine" Button
        const selectNoneBtn = container.querySelector('#btn-select-none');
        if (selectNoneBtn) {
            selectNoneBtn.onclick = () => {
                this._analysisSelected.clear();
                container.querySelectorAll('.fm-obj').forEach(cb => {
                    cb.checked = false;
                });
                container.querySelectorAll('.fm-profile-btn').forEach(b => {
                    b.style.background = '#333';
                    b.style.borderColor = '#444';
                });
            };
        }

        container.querySelectorAll('.fm-obj').forEach(cb => {
            cb.onchange = () => {
                const value = cb.value;
                if (cb.checked) this._analysisSelected.add(value);
                else this._analysisSelected.delete(value);
                // Reset profile button highlights when manually changing
                container.querySelectorAll('.fm-profile-btn').forEach(b => {
                    b.style.background = '#333';
                    b.style.borderColor = '#444';
                });
            };
        });

        container.querySelector('#analysis-device').onchange = (e) => {
            this._analysisDevice = e.target.value;
        };

        container.querySelector('#btn-analyze').onclick = () => {
            this.analyzeCurrentVideo();
        };

        const overlayToggle = container.querySelector('#analysis-overlay');
        if (overlayToggle) {
            overlayToggle.onchange = () => {
                this._overlayEnabled = overlayToggle.checked;
                this.updateOverlayStates();
                if (this._overlayEnabled) {
                    this.loadDetectionsForCurrentVideo();
                } else {
                    this._stopSmoothingLoop();
                    this.clearOverlay();
                }
            };
        }

        container.querySelector('#btn-analyze-all').onclick = () => {
            this.analyzeAllRecordings();
        };
        
        // v1.2.3: Restore batch progress UI if analysis is running
        if (this._batchProgress && this._batchProgress.running) {
            const progress = this._batchProgress;
            const btnEl = container.querySelector('#btn-analyze-all');
            const progressContainer = container.querySelector('#analysis-progress-container');
            const progressBar = container.querySelector('#analysis-progress-bar');
            const progressText = container.querySelector('#analysis-progress-text');
            
            if (progress.total > 0) {
                const percent = Math.round((progress.current / progress.total) * 100);
                
                if (progressContainer) progressContainer.style.display = 'block';
                if (progressBar) progressBar.style.width = percent + '%';
                if (progressText) {
                    const fileInfo = progress.current_file ? ` - ${progress.current_file}` : '';
                    progressText.textContent = `${progress.current} von ${progress.total} analysiert (${percent}%)${fileInfo}`;
                }
                if (btnEl) {
                    btnEl.innerHTML = `⏹️ Stopp (${progress.current}/${progress.total})`;
                    btnEl.style.background = '#c62828';
                    btnEl.disabled = false;
                    btnEl.onclick = () => this._stopBatchAnalysis();
                }
            }
        }
        
        // Pagination event handlers
        container.querySelectorAll('.pagination-btn').forEach(btn => {
            btn.onclick = () => {
                const page = parseInt(btn.dataset.page, 10);
                if (page && !btn.disabled) {
                    this.goToAnalysisPage(page);
                }
            };
        });
    }

    renderMovementTab(container) {
        container.innerHTML = `
            <div style="padding:20px;">
                <h3 style="margin:0 0 20px 0; color:var(--primary-text-color);">Bewegungsprofil</h3>
                <div style="margin-bottom:20px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                    <select id="movement-hours" style="padding:8px 12px; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color);">
                        <option value="1">Letzte Stunde</option>
                        <option value="6">Letzte 6 Stunden</option>
                        <option value="24" selected>Letzte 24 Stunden</option>
                        <option value="168">Letzte 7 Tage</option>
                    </select>
                    <select id="movement-view" style="padding:8px 12px; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color);">
                        <option value="timeline" selected>Timeline</option>
                        <option value="chart">Diagramm</option>
                        <option value="list">Liste</option>
                    </select>
                    <button id="movement-refresh" style="padding:8px 16px; border-radius:8px; border:none; background:var(--primary-color); color:white; cursor:pointer;">⟳</button>
                </div>
                <div id="movement-content" style="color:#888;">Lade Bewegungsprofil...</div>
            </div>
        `;
        
        const hoursSelect = container.querySelector('#movement-hours');
        const viewSelect = container.querySelector('#movement-view');
        const refreshBtn = container.querySelector('#movement-refresh');
        const contentDiv = container.querySelector('#movement-content');
        
        const loadProfile = () => this._loadMovementProfile(contentDiv, parseInt(hoursSelect.value), viewSelect.value);
        
        hoursSelect.addEventListener('change', loadProfile);
        viewSelect.addEventListener('change', loadProfile);
        refreshBtn.addEventListener('click', loadProfile);
        
        loadProfile();
    }
    
    async _loadMovementProfile(container, hours, viewMode = 'timeline') {
        container.textContent = 'Lade...';
        
        try {
            const result = await this._hass.callWS({
                type: 'rtsp_recorder/get_movement_profile',
                hours: hours
            });
            
            if (!result.movements || result.movements.length === 0) {
                container.innerHTML = '<div style="padding:40px; color:#888; text-align:center;"><div style="font-size:48px; margin-bottom:16px;">📭</div>Keine Bewegungen im ausgewählten Zeitraum gefunden.</div>';
                return;
            }
            
            // Group by person (field name from backend is "person")
            const byPerson = {};
            const byCamera = {};
            const byHour = {};
            const byHourPerCamera = {};
            const byHourPerPerson = {};
            
            result.movements.forEach(m => {
                const personName = m.person || 'Unbekannt';
                const cameraName = m.camera || 'Unbekannt';
                
                if (!byPerson[personName]) byPerson[personName] = [];
                byPerson[personName].push(m);
                
                if (!byCamera[cameraName]) byCamera[cameraName] = 0;
                byCamera[cameraName]++;
                
                // Parse time (field name from backend is "time")
                const date = new Date(m.time);
                if (!isNaN(date.getTime())) {
                    const hourKey = date.getHours();
                    if (!byHour[hourKey]) byHour[hourKey] = 0;
                    byHour[hourKey]++;
                    
                    // Per camera hourly
                    if (!byHourPerCamera[cameraName]) byHourPerCamera[cameraName] = {};
                    if (!byHourPerCamera[cameraName][hourKey]) byHourPerCamera[cameraName][hourKey] = 0;
                    byHourPerCamera[cameraName][hourKey]++;
                    
                    // Per person hourly
                    if (!byHourPerPerson[personName]) byHourPerPerson[personName] = {};
                    if (!byHourPerPerson[personName][hourKey]) byHourPerPerson[personName][hourKey] = 0;
                    byHourPerPerson[personName][hourKey]++;
                }
            });
            
            if (viewMode === 'chart') {
                this._renderMovementChart(container, byPerson, byCamera, byHour, byHourPerCamera, byHourPerPerson, result.total);
            } else if (viewMode === 'list') {
                this._renderMovementList(container, byPerson);
            } else {
                this._renderMovementTimeline(container, byPerson, result.movements);
            }
            
        } catch (e) {
            container.innerHTML = '<div style="padding:20px; color:#f44336; text-align:center;">Fehler beim Laden: ' + this._escapeHtml(e.message || String(e)) + '</div>';
        }
    }
    
    _renderMovementChart(container, byPerson, byCamera, byHour, byHourPerCamera, byHourPerPerson, total) {
        const maxCameraCount = Math.max(...Object.values(byCamera), 1);
        const maxHourCount = Math.max(...Object.values(byHour), 1);
        
        // Camera bar chart
        let cameraHtml = '<div style="margin-bottom:30px;"><h4 style="margin:0 0 16px 0; color:var(--primary-text-color);">📷 Erkennungen pro Kamera</h4>';
        for (const [camera, count] of Object.entries(byCamera).sort((a, b) => b[1] - a[1])) {
            const pct = (count / maxCameraCount) * 100;
            cameraHtml += `
                <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                        <span style="color:var(--primary-text-color);">${this._escapeHtml(camera)}</span>
                        <span style="color:#888;">${count}x</span>
                    </div>
                    <div style="background:var(--divider-color); border-radius:4px; height:24px; overflow:hidden;">
                        <div style="background:linear-gradient(90deg, #03a9f4, #00bcd4); width:${pct}%; height:100%; border-radius:4px; transition:width 0.5s;"></div>
                    </div>
                </div>
            `;
        }
        cameraHtml += '</div>';

        // Person bar chart
        const personCounts = {};
        for (const [name, movements] of Object.entries(byPerson)) {
            personCounts[name] = movements.length;
        }
        const maxPersonCount = Math.max(...Object.values(personCounts), 1);
        
        let personHtml = '<div style="margin-bottom:30px;"><h4 style="margin:0 0 16px 0; color:var(--primary-text-color);">👤 Erkennungen pro Person</h4>';
        for (const [person, count] of Object.entries(personCounts).sort((a, b) => b[1] - a[1])) {
            const pct = (count / maxPersonCount) * 100;
            personHtml += `
                <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                        <span style="color:var(--primary-text-color);">${this._escapeHtml(person)}</span>
                        <span style="color:#888;">${count}x</span>
                    </div>
                    <div style="background:var(--divider-color); border-radius:4px; height:24px; overflow:hidden;">
                        <div style="background:linear-gradient(90deg, #9c27b0, #e91e63); width:${pct}%; height:100%; border-radius:4px; transition:width 0.5s;"></div>
                    </div>
                </div>
            `;
        }
        personHtml += '</div>';
        
        // Hourly activity per Camera
        let hourCameraHtml = '<div style="margin-bottom:30px;"><h4 style="margin:0 0 16px 0; color:var(--primary-text-color);">📷 Aktivität pro Kamera (24h)</h4>';
        for (const [camera, hourData] of Object.entries(byHourPerCamera)) {
            const maxH = Math.max(...Object.values(hourData), 1);
            hourCameraHtml += `<div style="margin-bottom:16px;"><div style="color:var(--primary-text-color); margin-bottom:8px; font-size:13px;">${this._escapeHtml(camera)}</div>`;
            hourCameraHtml += '<div style="display:flex; align-items:flex-end; gap:2px; height:60px;">';
            for (let h = 0; h < 24; h++) {
                const count = hourData[h] || 0;
                const pct = maxH > 0 ? (count / maxH) * 100 : 0;
                const barColor = count > 0 ? 'linear-gradient(180deg, #03a9f4, #00bcd4)' : 'var(--divider-color)';
                hourCameraHtml += `<div style="flex:1; background:${barColor}; height:${Math.max(pct, 3)}%; border-radius:2px 2px 0 0; min-height:3px;" title="${this._escapeHtml(camera)}: ${count}x um ${h}:00"></div>`;
            }
            hourCameraHtml += '</div>';
            hourCameraHtml += '<div style="display:flex; justify-content:space-between; font-size:8px; color:#666; margin-top:2px;"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div></div>';
        }
        hourCameraHtml += '</div>';

        // Hourly activity per Person
        let hourPersonHtml = '<div style="margin-bottom:30px;"><h4 style="margin:0 0 16px 0; color:var(--primary-text-color);">👤 Aktivität pro Person (24h)</h4>';
        for (const [person, hourData] of Object.entries(byHourPerPerson)) {
            const maxH = Math.max(...Object.values(hourData), 1);
            hourPersonHtml += `<div style="margin-bottom:16px;"><div style="color:var(--primary-text-color); margin-bottom:8px; font-size:13px;">${this._escapeHtml(person)}</div>`;
            hourPersonHtml += '<div style="display:flex; align-items:flex-end; gap:2px; height:60px;">';
            for (let h = 0; h < 24; h++) {
                const count = hourData[h] || 0;
                const pct = maxH > 0 ? (count / maxH) * 100 : 0;
                const barColor = count > 0 ? 'linear-gradient(180deg, #9c27b0, #e91e63)' : 'var(--divider-color)';
                hourPersonHtml += `<div style="flex:1; background:${barColor}; height:${Math.max(pct, 3)}%; border-radius:2px 2px 0 0; min-height:3px;" title="${this._escapeHtml(person)}: ${count}x um ${h}:00"></div>`;
            }
            hourPersonHtml += '</div>';
            hourPersonHtml += '<div style="display:flex; justify-content:space-between; font-size:8px; color:#666; margin-top:2px;"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div></div>';
        }
        hourPersonHtml += '</div>';

        // Combined hourly overview
        let hourHtml = '<div><h4 style="margin:0 0 16px 0; color:var(--primary-text-color);">🕐 Gesamt-Aktivität (24h)</h4>';
        hourHtml += '<div style="display:flex; align-items:flex-end; gap:4px; height:80px; padding:10px 0;">';
        for (let h = 0; h < 24; h++) {
            const count = byHour[h] || 0;
            const pct = maxHourCount > 0 ? (count / maxHourCount) * 100 : 0;
            const barColor = count > 0 ? 'linear-gradient(180deg, #4caf50, #8bc34a)' : 'var(--divider-color)';
            hourHtml += `
                <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:2px;">
                    <div style="width:100%; background:${barColor}; height:${Math.max(pct, 3)}%; border-radius:2px 2px 0 0; min-height:3px;" title="${count} Erkennungen um ${h}:00"></div>
                    <span style="font-size:8px; color:#888;">${h}</span>
                </div>
            `;
        }
        hourHtml += '</div></div>';
        
        // Summary stats
        const statsHtml = `
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:24px;">
                <div style="background:var(--card-background-color); border-radius:12px; padding:16px; text-align:center; border:1px solid var(--divider-color);">
                    <div style="font-size:28px; font-weight:bold; color:var(--primary-color);">${total}</div>
                    <div style="color:#888; font-size:11px;">Gesamt</div>
                </div>
                <div style="background:var(--card-background-color); border-radius:12px; padding:16px; text-align:center; border:1px solid var(--divider-color);">
                    <div style="font-size:28px; font-weight:bold; color:#9c27b0;">${Object.keys(byPerson).length}</div>
                    <div style="color:#888; font-size:11px;">Personen</div>
                </div>
                <div style="background:var(--card-background-color); border-radius:12px; padding:16px; text-align:center; border:1px solid var(--divider-color);">
                    <div style="font-size:28px; font-weight:bold; color:#4caf50;">${Object.keys(byCamera).length}</div>
                    <div style="color:#888; font-size:11px;">Kameras</div>
                </div>
                <div style="background:var(--card-background-color); border-radius:12px; padding:16px; text-align:center; border:1px solid var(--divider-color);">
                    <div style="font-size:28px; font-weight:bold; color:#ff9800;">${Object.keys(byHour).length}</div>
                    <div style="color:#888; font-size:11px;">Aktive Std.</div>
                </div>
            </div>
        `;
        
        container.innerHTML = statsHtml + personHtml + cameraHtml + hourPersonHtml + hourCameraHtml + hourHtml;
    }
    
    _renderMovementTimeline(container, byPerson, movements) {
        let html = '<div style="display:flex; flex-direction:column; gap:24px;">';
        
        for (const [name, personMovements] of Object.entries(byPerson)) {
            const cameras = [...new Set(personMovements.map(m => m.camera))];
            const lastSeen = personMovements[0];
            const lastTime = new Date(lastSeen.time);
            const lastTimeStr = !isNaN(lastTime.getTime()) ? lastTime.toLocaleString('de-DE') : 'Unbekannt';
            
            html += `
                <div style="background:var(--card-background-color); border-radius:12px; padding:16px; border:1px solid var(--divider-color);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                        <h4 style="margin:0; color:var(--primary-color); display:flex; align-items:center; gap:8px;">
                            <span style="font-size:24px;">👤</span>
                            ${this._escapeHtml(name)}
                        </h4>
                        <span style="color:#888; font-size:12px;">${personMovements.length} Erkennungen</span>
                    </div>
                    
                    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px;">
                        ${cameras.map(c => `<span style="background:var(--primary-color); color:white; padding:4px 12px; border-radius:16px; font-size:12px;">📷 ${this._escapeHtml(c)}</span>`).join('')}
                    </div>
                    
                    <div style="position:relative; padding-left:20px; border-left:2px solid var(--divider-color);">
            `;
            
            personMovements.slice(0, 10).forEach((m, i) => {
                const time = new Date(m.time);
                const timeStr = !isNaN(time.getTime()) ? time.toLocaleString('de-DE') : 'Unbekannt';
                const confidence = m.confidence ? Math.round(m.confidence * 100) : 0;
                const isRecent = i === 0;
                
                html += `
                    <div style="position:relative; padding:8px 0 8px 16px; ${isRecent ? 'opacity:1;' : 'opacity:0.7;'}">
                        <div style="position:absolute; left:-7px; top:12px; width:12px; height:12px; border-radius:50%; background:${isRecent ? '#4caf50' : 'var(--divider-color)'}; border:2px solid var(--card-background-color);"></div>
                        <div style="font-weight:${isRecent ? '600' : '400'}; color:var(--primary-text-color);">${this._escapeHtml(m.camera)}</div>
                        <div style="font-size:12px; color:#888;">${timeStr} • ${confidence}%</div>
                    </div>
                `;
            });
            
            if (personMovements.length > 10) {
                html += `<div style="padding:8px 0 0 16px; color:#888; font-size:12px;">... und ${personMovements.length - 10} weitere</div>`;
            }
            
            html += '</div></div>';
        }
        
        html += '</div>';
        container.innerHTML = html;
    }
    
    _renderMovementList(container, byPerson) {
        let html = '<div style="display:flex; flex-direction:column; gap:16px;">';
        
        for (const [name, movements] of Object.entries(byPerson)) {
            html += `
                <div style="background:var(--card-background-color); border-radius:12px; padding:16px; border:1px solid var(--divider-color);">
                    <h4 style="margin:0 0 12px 0; color:var(--primary-color);">👤 ${this._escapeHtml(name)}</h4>
                    <div style="display:flex; flex-direction:column; gap:8px; max-height:300px; overflow-y:auto;">
            `;
            
            movements.slice(0, 30).forEach(m => {
                const time = new Date(m.time);
                const timeStr = !isNaN(time.getTime()) ? time.toLocaleString('de-DE') : 'Unbekannt';
                const confidence = m.confidence ? Math.round(m.confidence * 100) : 0;
                html += `
                    <div style="display:flex; align-items:center; gap:12px; padding:10px; background:var(--secondary-background-color); border-radius:8px;">
                        <span style="font-size:20px;">📍</span>
                        <div style="flex:1;">
                            <div style="font-weight:500; color:var(--primary-text-color);">${this._escapeHtml(m.camera)}</div>
                            <div style="font-size:12px; color:#888;">${timeStr} • ${confidence}%</div>
                        </div>
                    </div>
                `;
            });
            
            if (movements.length > 30) {
                html += `<div style="text-align:center; color:#888; padding:8px;">... und ${movements.length - 30} weitere</div>`;
            }
            
            html += '</div></div>';
        }
        
        html += '</div>';
        container.innerHTML = html;
    }

        renderPeopleTab(container) {
        if (!this._peopleLoaded) {
            container.innerHTML = '<div style="color:#888; padding:20px;">Lade Personen...</div>';
            this.refreshPeople().then(() => {
                if (this._activeTab === 'people') {
                    this.renderPeopleTab(container);
                }
            });
            return;
        }

        const people = this._people || [];
        const peopleOptions = people.map(p => {
            const selected = this._selectedPersonId === p.id ? 'selected' : '';
            return `<option value="${p.id}" ${selected}>${p.name} (${p.embeddings_count})</option>`;
        }).join('');

        const peopleList = people.map(p => {
            const thumbs = (p.recent_thumbs || []).slice(0, 5).map((t, idx) =>
                `<img src="${t}" 
                    style="width:48px; height:48px; object-fit:cover; border-radius:8px; border:2px solid #444; cursor:pointer; transition:transform 0.2s, border-color 0.2s;" 
                    data-person-id="${p.id}" 
                    data-thumb-idx="${idx}"
                    title="Klicken zum Vergrößern"
                    onmouseover="this.style.transform='scale(1.1)'; this.style.borderColor='var(--primary-color)';"
                    onmouseout="this.style.transform='scale(1)'; this.style.borderColor='#444';"
                />`
            ).join('');
            const negCount = p.negative_count || 0;
            const negBadge = negCount > 0 ? `<span style="background:#e74c3c; color:white; padding:2px 6px; border-radius:10px; font-size:0.7em; margin-left:6px;" title="${negCount} Negativ-Samples">-${negCount}</span>` : '';
            return `
                <div class="person-card" style="background:#1a1a1a; border-radius:12px; padding:12px; margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div style="flex:1; cursor:pointer;" data-action="show-details" data-person-id="${p.id}">
                            <div style="font-weight:600; font-size:1.1em; margin-bottom:4px; display:flex; align-items:center;">
                                <span class="person-name-link" style="color:var(--primary-color); text-decoration:underline; cursor:pointer;">${this._escapeHtml(p.name)}</span>
                                ${negBadge}
                            </div>
                            <div style="font-size:0.85em; color:#888;">📸 ${p.embeddings_count} Embeddings</div>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button class="fm-btn" data-action="rename" data-id="${p.id}" style="padding:6px 12px; font-size:0.85em;">✏️</button>
                            <button class="fm-btn-danger" data-action="delete" data-id="${p.id}" style="padding:6px 12px; font-size:0.85em;">🗑️</button>
                        </div>
                    </div>
                    ${thumbs ? `<div style="margin-top:10px; display:flex; gap:6px; flex-wrap:wrap;">${thumbs}</div>` : '<div style="margin-top:10px; color:#666; font-size:0.85em;">Keine Vorschaubilder</div>'}
                </div>
            `;
        }).join('');

        const faceSamples = this._analysisFaceSamples || [];
        if (!this._enrolledSampleKeys) {
            this._enrolledSampleKeys = new Set();
        }
        
        // Gruppiere Face-Samples: Unbekannt vs. Erkannt
        const unknownFaces = faceSamples.filter(f => !f.match);
        const knownFaces = faceSamples.filter(f => f.match);
        
        const renderFaceGrid = (faces, showAssignBtn = true) => {
            if (!faces.length) return '';
            return faces.slice(0, 20).map((f, idx) => {
                const realIdx = faceSamples.indexOf(f);
                const match = f.match ? `${f.match.name}` : '';
                const similarity = f.match ? `${Math.round(f.match.similarity * 100)}%` : '';
                const sampleKey = `${f.time_s}|${f.thumb || ''}`;
                const isEnrolled = this._enrolledSampleKeys.has(sampleKey);
                const borderColor = isEnrolled ? '#27ae60' : (f.match ? 'var(--primary-color)' : '#555');
                
                return `
                    <div class="face-sample" style="display:flex; flex-direction:column; align-items:center; width:85px; ${isEnrolled ? 'opacity:0.6;' : ''}">
                        <div style="position:relative;">
                            ${f.thumb 
                                ? `<img src="${f.thumb}" style="width:70px; height:70px; object-fit:cover; border-radius:10px; border:3px solid ${borderColor}; cursor:pointer;" 
                                    data-action="enroll" data-idx="${realIdx}" title="Klicken zum Zuweisen" />`
                                : `<div style="width:70px; height:70px; background:#333; border-radius:10px; display:flex; align-items:center; justify-content:center;">👤</div>`
                            }
                            ${isEnrolled 
                                ? '<div style="position:absolute; top:-5px; right:-5px; background:#27ae60; border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:12px;">✓</div>' 
                                : `<div class="skip-face-icon" data-idx="${realIdx}" style="position:absolute; top:-8px; right:-8px; background:#e74c3c; border:2px solid #222; border-radius:50%; width:22px; height:22px; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold; cursor:pointer; opacity:0.85; transition:all 0.2s; box-shadow:0 2px 4px rgba(0,0,0,0.5);" title="Bild entfernen">✕</div>`
                            }
                        </div>
                        <div style="font-size:0.7em; color:#888; margin-top:4px; text-align:center; max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${match || `t=${f.time_s}s`}
                        </div>
                        ${similarity ? `<div style="font-size:0.65em; color:var(--primary-color);">${similarity}</div>` : ''}
                    </div>
                `;
            }).join('');
        };
        
        const unknownFacesHtml = unknownFaces.length 
            ? `<div style="margin-bottom:15px;">
                <div style="font-weight:500; margin-bottom:8px; color:#e74c3c;">👤 Unbekannte Gesichter (${unknownFaces.length})</div>
                <div style="display:flex; flex-wrap:wrap; gap:8px; padding:10px; background:#1a1a1a; border-radius:10px; max-height:400px; overflow-y:auto;">
                    ${renderFaceGrid(unknownFaces, true)}
                </div>
               </div>`
            : '';
            
        const knownFacesHtml = knownFaces.length
            ? `<div>
                <div style="font-weight:500; margin-bottom:8px; color:#27ae60;">✓ Erkannte Gesichter (${knownFaces.length})</div>
                <div style="display:flex; flex-wrap:wrap; gap:8px; padding:10px; background:#1a1a1a; border-radius:10px; max-height:400px; overflow-y:auto;">
                    ${renderFaceGrid(knownFaces, false)}
                </div>
               </div>`
            : '';
        
        const noFacesHtml = !faceSamples.length ? '<div style="color:#888; padding:20px; text-align:center;">Keine Face-Samples geladen.<br><small>Wähle eine Aufnahme und klicke "Analyse laden"</small></div>' : '';

        container.innerHTML = `
            <div style="padding:10px;">
                <div style="font-weight:500; margin-bottom:10px;">Personen verwalten</div>
                <div style="display:flex; gap:8px; margin-bottom:12px;">
                    <input id="person-name" type="text" placeholder="Neuer Name" style="flex:1; padding:8px; background:#222; color:#eee; border:1px solid #333; border-radius:6px;" />
                    <button class="fm-btn" id="btn-add-person">Hinzufuegen</button>
                </div>
                <div id="people-list">
                    ${peopleList || '<div style="color:#888;">Keine Personen vorhanden</div>'}
                </div>

                <div style="margin-top:20px; border-top:1px solid #333; padding-top:15px;">
                    <div style="font-weight:500; margin-bottom:10px;">Training aus Analyse</div>
                    <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                        <select id="people-select" style="flex:1; padding:8px; background:#222; color:#eee; border:1px solid #333; border-radius:6px;">
                            <option value="">-- Person waehlen --</option>
                            ${peopleOptions}
                        </select>
                        <button class="fm-btn" id="btn-load-faces">Analyse laden</button>
                    </div>
                    
                    ${unknownFacesHtml}
                    ${knownFacesHtml}
                    ${noFacesHtml}
                    
                    ${faceSamples.length ? `<div style="margin-top:15px; padding:12px 15px; background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius:10px; border:1px solid #333;">
                        <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
                            <span style="font-size:1.3em;">👆</span>
                            <span style="color:#aaa; font-size:0.85em;"><strong style="color:#3498db;">Bild klicken</strong> = Person zuweisen oder korrigieren</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px;">
                            <span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; background:#e74c3c; border-radius:50%; font-size:11px; font-weight:bold;">✕</span>
                            <span style="color:#aaa; font-size:0.85em;"><strong style="color:#e74c3c;">X klicken</strong> = Bild überspringen / entfernen</span>
                        </div>
                    </div>` : ''}
                </div>
            </div>
        `;

        const addBtn = container.querySelector('#btn-add-person');
        if (addBtn) {
            addBtn.onclick = async () => {
                const input = container.querySelector('#person-name');
                const name = input ? input.value.trim() : '';
                if (!name) {
                    this.showToast('Bitte Namen eingeben', 'warning');
                    return;
                }
                await this.addPerson(name);
                if (input) input.value = '';
            };
        }

        container.querySelectorAll('[data-action="rename"]').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.getAttribute('data-id');
                const current = people.find(p => p.id === id);
                const newName = prompt('Neuer Name', current ? current.name : '');
                if (newName && newName.trim()) {
                    await this.renamePerson(id, newName.trim());
                }
            };
        });

        container.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.getAttribute('data-id');
                const current = people.find(p => p.id === id);
                if (confirm(`Person "${current ? current.name : ''}" wirklich loeschen?`)) {
                    await this.deletePerson(current || { id });
                }
            };
        });

        // v1.1.0n: Event-Handler für Person-Details Popup
        container.querySelectorAll('[data-action="show-details"]').forEach(el => {
            el.onclick = async (e) => {
                // Prevent click if clicking on rename/delete buttons
                if (e.target.closest('[data-action="rename"]') || e.target.closest('[data-action="delete"]')) {
                    return;
                }
                const personId = el.getAttribute('data-person-id');
                if (personId) {
                    await this.showPersonDetailPopup(personId);
                }
            };
        });

        const loadFacesBtn = container.querySelector('#btn-load-faces');
        if (loadFacesBtn) {
            loadFacesBtn.onclick = async () => {
                if (this._loadingFaceSamples) return;
                await this.loadFaceSamplesForCurrent();
                if (this._activeTab === 'people') {
                    this.renderPeopleTab(container);
                }
            };
        }

        const selectEl = container.querySelector('#people-select');
        if (selectEl) {
            selectEl.onchange = () => {
                this._selectedPersonId = selectEl.value || null;
            };
        }

        // Event-Handler für Skip-Icon (X im Bild)
        container.querySelectorAll('.skip-face-icon').forEach(el => {
            el.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                const idx = parseInt(el.getAttribute('data-idx'), 10);
                const sample = this._analysisFaceSamples[idx];
                if (sample && sample.embedding) {
                    // Backend-Call zum permanenten Ignorieren
                    await this.addIgnoredEmbedding(sample.embedding, sample.thumb || null);
                } else if (sample) {
                    // Fallback: nur lokales Markieren wenn kein Embedding
                    const sampleKey = `${sample.time_s}|${sample.thumb || ''}`;
                    if (!this._enrolledSampleKeys) this._enrolledSampleKeys = new Set();
                    this._enrolledSampleKeys.add(sampleKey);
                    this.showToast('Bild übersprungen (lokal)', 'info');
                    if (this._activeTab === 'people') {
                        this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
                    }
                }
            };
            el.onmouseover = () => { el.style.opacity = '1'; el.style.transform = 'scale(1.15)'; };
            el.onmouseout = () => { el.style.opacity = '0.85'; el.style.transform = 'scale(1)'; };
        });

        // Event-Handler für Enroll (Button oder Bild-Klick)
        container.querySelectorAll('[data-action="enroll"]').forEach(el => {
            el.onclick = async (e) => {
                e.preventDefault();
                const idx = parseInt(el.getAttribute('data-idx'), 10);
                const personId = this._selectedPersonId;
                const sample = this._analysisFaceSamples[idx];
                if (!sample) return;
                
                // Prüfe ob Sample bereits zugewiesen ist (grün markiert)
                const sampleKey = `${sample.time_s}|${sample.thumb || ''}`;
                if (!this._enrolledSampleKeys) this._enrolledSampleKeys = new Set();
                const isAlreadyEnrolled = this._enrolledSampleKeys.has(sampleKey);
                
                // Wenn BEREITS zugewiesen → Korrektur-Popup zeigen
                // Wenn NICHT zugewiesen UND Person ausgewählt → direkt zuweisen
                // Wenn NICHT zugewiesen UND KEINE Person ausgewählt → Popup zeigen
                
                if (!isAlreadyEnrolled && personId) {
                    // Direkt zur ausgewählten Person hinzufügen
                    if (!sample.embedding) {
                        this.showToast('Kein Embedding im Sample vorhanden', 'warning');
                        return;
                    }
                    // Markiere sofort als enrolled BEVOR der API-Call
                    this._enrolledSampleKeys.add(sampleKey);
                    await this.addEmbeddingToPerson(personId, sample.embedding, sample.thumb || null);
                    return;
                }
                
                // Popup zeigen (für Korrektur oder wenn keine Person ausgewählt)
                const people = this._people || [];
                if (people.length === 0) {
                    this.showToast('Bitte erst eine Person anlegen', 'warning');
                    return;
                }
                
                const popup = document.createElement('div');
                popup.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:10000;';
                popup.innerHTML = `
                    <div style="background:#222; border-radius:16px; padding:20px; max-width:400px; width:90%;">
                        <div style="text-align:center; margin-bottom:15px;">
                            ${sample.thumb ? `<img src="${this._escapeHtml(sample.thumb)}" style="width:100px; height:100px; object-fit:cover; border-radius:12px; border:3px solid var(--primary-color);" />` : ''}
                            <div style="margin-top:10px; font-weight:500;">${isAlreadyEnrolled ? 'Person korrigieren' : 'Person zuweisen'}</div>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:8px; max-height:200px; overflow-y:auto;">
                            ${people.map(p => `
                                <div style="display:flex; gap:4px;">
                                    <button class="quick-assign-btn" data-person-id="${this._escapeHtml(p.id)}" style="flex:1; padding:10px; background:#333; border:none; border-radius:8px 0 0 8px; color:#fff; cursor:pointer; text-align:left; display:flex; align-items:center; gap:10px;">
                                        ${p.recent_thumbs && p.recent_thumbs[0] ? `<img src="${this._escapeHtml(p.recent_thumbs[0])}" style="width:36px; height:36px; object-fit:cover; border-radius:6px;" />` : '<div style="width:36px; height:36px; background:#444; border-radius:6px; display:flex; align-items:center; justify-content:center;">👤</div>'}
                                        <div>
                                            <div style="font-weight:500;">${this._escapeHtml(p.name)}</div>
                                            <div style="font-size:0.75em; color:#888;">${p.embeddings_count} Samples</div>
                                        </div>
                                    </button>
                                    <button class="negative-sample-btn" data-person-id="${this._escapeHtml(p.id)}" data-person-name="${this._escapeHtml(p.name)}" style="padding:10px 12px; background:#663333; border:none; border-radius:0 8px 8px 0; color:#fff; cursor:pointer; font-size:0.9em;" title="Das ist NICHT ${this._escapeHtml(p.name)}">
                                        ❌
                                    </button>
                                </div>
                            `).join('')}
                            </div>
                            <div style="margin-top:10px; border-top:1px solid #444; padding-top:10px;">
                                <button class="skip-face-btn" style="width:100%; padding:12px; background:#444; border:none; border-radius:8px; color:#aaa; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;">
                                    <span style="font-size:1.2em;">🚫</span>
                                    <span>Keine Person / Überspringen</span>
                                </button>
                            </div>
                            <div style="margin-top:12px; padding:10px; background:#333; border-radius:8px; font-size:0.8em; color:#aaa;">
                                💡 <strong>Zuweisen:</strong> Person links klicken<br>
                                ❌ <strong>Ausschließen:</strong> ❌ rechts = "Das ist NICHT diese Person"<br>
                                🚫 <strong>Überspringen:</strong> Kein Gesicht / Fehlererkennung
                            </div>
                            <button class="close-popup-btn" style="margin-top:12px; width:100%; padding:10px; background:#555; border:none; border-radius:8px; color:#fff; cursor:pointer;">Abbrechen</button>
                        </div>
                    `;
                    
                    document.body.appendChild(popup);
                    
                    // Event-Handler für Schnellauswahl (Positiv)
                    popup.querySelectorAll('.quick-assign-btn').forEach(btn => {
                        btn.onclick = async () => {
                            const selectedId = btn.getAttribute('data-person-id');
                            document.body.removeChild(popup);
                            if (sample.embedding) {
                                await this.addEmbeddingToPerson(selectedId, sample.embedding, sample.thumb || null);
                            } else {
                                this.showToast('Kein Embedding im Sample vorhanden', 'warning');
                            }
                        };
                        btn.onmouseover = () => btn.style.background = '#444';
                        btn.onmouseout = () => btn.style.background = '#333';
                    });
                    
                    // Event-Handler für Negativ-Samples
                    popup.querySelectorAll('.negative-sample-btn').forEach(btn => {
                        btn.onclick = async () => {
                            const personId = btn.getAttribute('data-person-id');
                            const personName = btn.getAttribute('data-person-name');
                            document.body.removeChild(popup);
                            if (sample.embedding) {
                                await this.addNegativeSample(personId, personName, sample.embedding, sample.thumb || null);
                            } else {
                                this.showToast('Kein Embedding im Sample vorhanden', 'warning');
                            }
                        };
                        btn.onmouseover = () => btn.style.background = '#884444';
                        btn.onmouseout = () => btn.style.background = '#663333';
                    });
                    
                    // Event-Handler für "Überspringen" (Bild ignorieren - Backend-Call)
                    // Speichere this-Referenz für Callbacks
                    const self = this;
                    
                    const skipBtn = popup.querySelector('.skip-face-btn');
                    if (skipBtn) {
                        skipBtn.onclick = async () => {
                            // Popup entfernen
                            if (popup.parentNode) {
                                popup.parentNode.removeChild(popup);
                            }
                            
                            // Backend-Call zum permanenten Ignorieren
                            if (sample.embedding) {
                                await self.addIgnoredEmbedding(sample.embedding, sample.thumb || null);
                            } else {
                                // Fallback: nur lokales Markieren
                                const sampleKey = `${sample.time_s}|${sample.thumb || ''}`;
                                if (!self._enrolledSampleKeys) self._enrolledSampleKeys = new Set();
                                self._enrolledSampleKeys.add(sampleKey);
                                self.showToast('Bild übersprungen (lokal)', 'info');
                                if (self._activeTab === 'people') {
                                    self.renderPeopleTab(self.shadowRoot.querySelector('#menu-content'));
                                }
                            }
                        };
                        skipBtn.onmouseover = () => skipBtn.style.background = '#555';
                        skipBtn.onmouseout = () => skipBtn.style.background = '#444';
                    }
                    
                    popup.querySelector('.close-popup-btn').onclick = () => document.body.removeChild(popup);
                    popup.onclick = (e) => { if (e.target === popup) document.body.removeChild(popup); };
            };
        });
    }

    async refreshPeople() {
        try {
            const data = await this._hass.callWS({ type: 'rtsp_recorder/get_people' });
            const peopleRaw = (data && data.people) ? data.people : [];
            this._people = peopleRaw.map(p => ({
                ...p,
                id: String(p.id),
                embeddings_count: (p.embeddings_count != null) ? p.embeddings_count : (p.embeddings ? p.embeddings.length : 0),
                recent_thumbs: p.recent_thumbs || []
            }));
            this._peopleLoaded = true;
        } catch (e) {
            this._people = [];
            this._peopleLoaded = true;
        }
    }

    async addPerson(name) {
        try {
            await this._hass.callWS({ type: 'rtsp_recorder/add_person', name });
            await this.refreshPeople();
            this.showToast('Person hinzugefuegt', 'success');
            if (this._activeTab === 'people') {
                this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
            }
        } catch (e) {
            this.showToast('Fehler beim Hinzufuegen: ' + (e.message || e), 'error');
        }
    }

    async renamePerson(id, name) {
        try {
            await this._hass.callWS({ type: 'rtsp_recorder/rename_person', id: String(id), name });
            await this.refreshPeople();
            this.showToast('Person umbenannt', 'success');
            if (this._activeTab === 'people') {
                this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
            }
        } catch (e) {
            this.showToast('Fehler beim Umbenennen: ' + (e.message || e), 'error');
        }
    }

    async deletePerson(personOrId) {
        try {
            const payload = (personOrId && typeof personOrId === 'object')
                ? {
                    type: 'rtsp_recorder/delete_person',
                    id: String(personOrId.id),
                    name: personOrId.name || null,
                    created_utc: personOrId.created_utc || null,
                }
                : { type: 'rtsp_recorder/delete_person', id: String(personOrId) };
            await this._hass.callWS(payload);
            await this.refreshPeople();
            this.showToast('Person geloescht', 'success');
            if (this._activeTab === 'people') {
                this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
            }
        } catch (e) {
            this.showToast('Fehler beim Loeschen: ' + (e.message || e), 'error');
        }
    }

    async addEmbeddingToPerson(personId, embedding, thumb = null) {
        try {
            const person = (this._people || []).find(p => String(p.id) === String(personId));
            const payload = {
                type: 'rtsp_recorder/add_person_embedding',
                person_id: String(personId),
                embedding,
                source: 'analysis',
                thumb
            };
            if (person) {
                payload.name = person.name || null;
                payload.created_utc = person.created_utc || null;
            }
            const res = await this._hass.callWS(payload);
            const rl = !!(res && res.rate_limited);
            if (this._analysisFaceSamples) {
                const sample = this._analysisFaceSamples.find(s => s.embedding === embedding && s.thumb === thumb);
                if (sample) {
                    const key = `${sample.time_s}|${sample.thumb || ''}`;
                    if (!this._enrolledSampleKeys) this._enrolledSampleKeys = new Set();
                    // bei Rate-Limit den optimistisch gesetzten Key zuruecknehmen (kein falsches Gruen)
                    if (rl) this._enrolledSampleKeys.delete(key); else this._enrolledSampleKeys.add(key);
                }
            }
            if (rl) {
                this.showToast('⏳ Rate-Limit erreicht – kurz warten und erneut versuchen', 'error');
                if (this._activeTab === 'people') {
                    this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
                }
                return;
            }
            await this.refreshPeople();
            this.showToast('Embedding hinzugefuegt', 'success');
            if (this._activeTab === 'people') {
                this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
            }
        } catch (e) {
            this.showToast('Fehler beim Embedding: ' + (e.message || e), 'error');
        }
    }

    async addNegativeSample(personId, personName, embedding, thumb = null) {
        // Fügt ein Negativ-Sample hinzu: "Das ist NICHT diese Person"
        try {
            const payload = {
                type: 'rtsp_recorder/add_negative_sample',
                person_id: String(personId),
                embedding,
                thumb
            };
            const res = await this._hass.callWS(payload);
            if (res && res.rate_limited) {
                this.showToast('⏳ Rate-Limit erreicht – kurz warten und erneut versuchen', 'error');
                return;
            }

            // Markiere das Sample als bearbeitet
            if (this._analysisFaceSamples) {
                const sample = this._analysisFaceSamples.find(s => s.embedding === embedding && s.thumb === thumb);
                if (sample) {
                    const key = `${sample.time_s}|${sample.thumb || ''}`;
                    if (!this._enrolledSampleKeys) this._enrolledSampleKeys = new Set();
                    this._enrolledSampleKeys.add(key);
                }
            }

            await this.refreshPeople();
            this.showToast(`Negativ-Sample fuer "${personName}" gespeichert`, 'success');
            if (this._activeTab === 'people') {
                this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
            }
        } catch (e) {
            this.showToast('Fehler beim Negativ-Sample: ' + (e.message || e), 'error');
        }
    }

    async addIgnoredEmbedding(embedding, thumb = null) {
        // Fügt ein Embedding zur Ignorieren-Liste hinzu (wird bei zukünftigen Analysen übersprungen)
        try {
            const payload = {
                type: 'rtsp_recorder/add_ignored_embedding',
                embedding,
                thumb
            };
            const result = await this._hass.callWS(payload);
            if (result && result.rate_limited) {
                this.showToast('⏳ Rate-Limit erreicht – kurz warten und erneut versuchen', 'error');
                return false;
            }

            // Markiere das Sample als bearbeitet
            if (this._analysisFaceSamples) {
                const sample = this._analysisFaceSamples.find(s => s.embedding === embedding && s.thumb === thumb);
                if (sample) {
                    const key = `${sample.time_s}|${sample.thumb || ''}`;
                    if (!this._enrolledSampleKeys) this._enrolledSampleKeys = new Set();
                    this._enrolledSampleKeys.add(key);
                }
            }

            this.showToast(`Gesicht ignoriert (${result.ignored_count} insgesamt)`, 'info');
            if (this._activeTab === 'people') {
                this.renderPeopleTab(this.shadowRoot.querySelector('#menu-content'));
            }
            return true;
        } catch (e) {
            this.showToast('Fehler beim Ignorieren: ' + (e.message || e), 'error');
            return false;
        }
    }

    // v1.2.0: Person Detail Popup with quality scores, outlier detection and bulk selection
    async showPersonDetailPopup(personId) {
        try {
            // Load person details with quality scores from backend
            const details = await this._hass.callWS({
                type: 'rtsp_recorder/get_person_details_quality',
                person_id: String(personId),
                outlier_threshold: 0.65
            });
            
            if (!details) {
                this.showToast('Person nicht gefunden', 'error');
                return;
            }
            
            // Track selected samples for bulk delete
            const selectedSamples = new Set();
            
            // Format dates
            const formatDate = (dateStr) => {
                if (!dateStr) return '-';
                try {
                    const d = new Date(dateStr);
                    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                } catch {
                    return dateStr;
                }
            };
            
            // Get quality color based on score
            const getQualityColor = (score) => {
                if (score === null || score === undefined) return '#888';
                if (score >= 85) return '#27ae60';  // Green - excellent
                if (score >= 70) return '#f39c12';  // Orange - good
                if (score >= 55) return '#e67e22';  // Dark orange - mediocre
                return '#e74c3c';  // Red - poor/outlier
            };
            
            // Render sample grid with quality indicators and selection
            const renderSamples = (samples, type) => {
                if (!samples || samples.length === 0) {
                    return `<div style="color:#888; text-align:center; padding:20px;">Keine ${type === 'positive' ? 'positiven' : 'negativen'} Samples vorhanden</div>`;
                }
                return samples.map(s => {
                    const isOutlier = s.is_outlier === true;
                    const qualityScore = s.quality_score;
                    const qualityColor = getQualityColor(qualityScore);
                    const borderColor = isOutlier ? '#e74c3c' : (type === 'positive' ? '#27ae60' : '#e74c3c');
                    const outlierBadge = isOutlier ? `<div style="position:absolute; top:-8px; left:-8px; background:#e74c3c; color:white; font-size:9px; padding:2px 4px; border-radius:4px; font-weight:bold;">⚠️</div>` : '';
                    
                    return `
                    <div class="sample-item" data-id="${s.id}" data-type="${type}" data-is-outlier="${isOutlier}" style="display:inline-block; margin:4px; position:relative; cursor:pointer;">
                        <input type="checkbox" class="sample-checkbox" data-id="${s.id}" data-type="${type}" 
                            style="position:absolute; top:-5px; left:-5px; width:16px; height:16px; z-index:10; cursor:pointer; accent-color:#3498db;" />
                        ${outlierBadge}
                        ${s.thumb 
                            ? `<img src="${this._escapeHtml(s.thumb)}" style="width:75px; height:75px; object-fit:cover; border-radius:8px; border:3px solid ${borderColor}; ${isOutlier ? 'opacity:0.7;' : ''}" />`
                            : `<div style="width:75px; height:75px; background:#333; border-radius:8px; display:flex; align-items:center; justify-content:center; border:3px solid ${borderColor};">👤</div>`
                        }
                        <button class="delete-sample-btn" data-id="${s.id}" data-type="${type}" 
                            style="position:absolute; top:-5px; right:-5px; width:20px; height:20px; border-radius:50%; background:#e74c3c; border:2px solid #222; color:white; font-size:11px; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0.9; transition:all 0.2s;"
                            title="Sample löschen">✕</button>
                        ${type === 'positive' && qualityScore !== null ? `
                        <div style="position:absolute; bottom:18px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.8); color:${qualityColor}; font-size:9px; padding:1px 4px; border-radius:3px; font-weight:bold;">
                            ${qualityScore}%
                        </div>
                        ` : ''}
                        <div style="font-size:0.6em; color:#777; text-align:center; margin-top:2px; max-width:75px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${formatDate(s.created_at).split(',')[0] || ''}
                        </div>
                    </div>
                `;
                }).join('');
            };
            
            // Create popup
            const popup = document.createElement('div');
            popup.className = 'person-detail-popup';
            popup.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:10001;';
            popup.innerHTML = `
                <div style="background:#1a1a1a; border-radius:16px; padding:24px; max-width:950px; width:95%; max-height:92vh; overflow-y:auto; border:1px solid #333;">
                    <!-- Header -->
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-bottom:15px; border-bottom:1px solid #333;">
                        <div>
                            <h2 style="margin:0; color:var(--primary-color); font-size:1.5em;">👤 ${this._escapeHtml(details.name)}</h2>
                            <div style="color:#888; font-size:0.85em; margin-top:4px;">ID: ${this._escapeHtml(details.id)}</div>
                        </div>
                        <button class="close-detail-popup" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer; padding:5px 10px;">✕</button>
                    </div>
                    
                    <!-- Stats -->
                    <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:20px;">
                        <div style="background:#222; padding:12px; border-radius:10px; text-align:center;">
                            <div style="font-size:1.8em; font-weight:bold; color:#27ae60;">${details.positive_count || 0}</div>
                            <div style="font-size:0.75em; color:#888;">Positiv</div>
                        </div>
                        <div style="background:#222; padding:12px; border-radius:10px; text-align:center;">
                            <div style="font-size:1.8em; font-weight:bold; color:#e74c3c;">${details.negative_count || 0}</div>
                            <div style="font-size:0.75em; color:#888;">Negativ</div>
                        </div>
                        <div style="background:#222; padding:12px; border-radius:10px; text-align:center;">
                            <div style="font-size:1.8em; font-weight:bold; color:#3498db;">${details.recognition_count || 0}</div>
                            <div style="font-size:0.75em; color:#888;">Erkennungen</div>
                        </div>
                        <div style="background:#222; padding:12px; border-radius:10px; text-align:center;">
                            <div style="font-size:1.1em; font-weight:bold; color:${details.last_seen ? '#9b59b6' : '#666'};">${details.last_seen ? formatDate(details.last_seen) : '-'}</div>
                            <div style="font-size:0.8em; color:#aaa; margin-top:2px;">${details.last_seen ? (details.last_camera ? this._escapeHtml(details.last_camera) : 'Zuletzt') : 'Nie gesehen'}</div>
                        </div>
                    </div>
                    
                    <!-- v1.2.0: Quality Stats Row -->
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:20px;">
                        <div style="background:#222; padding:12px; border-radius:10px; text-align:center;">
                            <div style="font-size:1.4em; font-weight:bold; color:${details.avg_quality >= 80 ? '#27ae60' : details.avg_quality >= 60 ? '#f39c12' : '#e74c3c'};">${details.avg_quality || 0}%</div>
                            <div style="font-size:0.75em; color:#888;">Ø Qualität</div>
                        </div>
                        <div style="background:#222; padding:12px; border-radius:10px; text-align:center;">
                            <div style="font-size:1.4em; font-weight:bold; color:${details.outlier_count > 0 ? '#e74c3c' : '#27ae60'};">${details.outlier_count || 0}</div>
                            <div style="font-size:0.75em; color:#888;">Ausreißer</div>
                        </div>
                        <div style="background:#222; padding:12px; border-radius:10px; text-align:center;">
                            <div style="font-size:1.4em; font-weight:bold; color:#3498db;">&lt;${details.outlier_threshold || 65}%</div>
                            <div style="font-size:0.75em; color:#888;">Schwelle</div>
                        </div>
                    </div>
                    
                    <!-- Created Info -->
                    <div style="font-size:0.8em; color:#666; margin-bottom:15px;">
                        📅 Erstellt: ${formatDate(details.created_at)}
                    </div>
                    
                    <!-- v1.2.0: Bulk Actions -->
                    <div id="bulk-actions" style="display:none; background:#1a3a5a; padding:12px; border-radius:10px; margin-bottom:15px; border:1px solid #2a5a8a;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <span style="color:#5dade2; font-weight:bold;">📋 Ausgewählt: </span>
                                <span id="selected-count" style="color:#fff;">0</span>
                            </div>
                            <div style="display:flex; gap:10px;">
                                <button id="btn-select-all-outliers" style="background:#e67e22; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:0.85em;">
                                    ⚠️ Alle Ausreißer
                                </button>
                                <button id="btn-deselect-all" style="background:#7f8c8d; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:0.85em;">
                                    ✖ Auswahl aufheben
                                </button>
                                <button id="btn-delete-selected" style="background:#e74c3c; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:0.85em;">
                                    🗑️ Ausgewählte löschen
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Positive Samples -->
                    <div style="margin-bottom:15px;">
                        <h3 style="margin:0 0 10px 0; color:#27ae60; font-size:1em; display:flex; align-items:center; gap:8px;">
                            <span>✓ Positive Samples</span>
                            <span style="background:#27ae60; color:white; padding:2px 8px; border-radius:10px; font-size:0.8em;">${details.positive_count || 0}</span>
                            ${details.outlier_count > 0 ? `<span style="background:#e74c3c; color:white; padding:2px 8px; border-radius:10px; font-size:0.8em;">⚠️ ${details.outlier_count} Ausreißer</span>` : ''}
                        </h3>
                        <div style="background:#222; padding:10px; border-radius:10px; max-height:280px; overflow-y:auto;">
                            ${renderSamples(details.positive_samples, 'positive')}
                        </div>
                    </div>
                    
                    <!-- Negative Samples -->
                    <div style="margin-bottom:15px;">
                        <h3 style="margin:0 0 10px 0; color:#e74c3c; font-size:1em; display:flex; align-items:center; gap:8px;">
                            <span>✗ Negative Samples</span>
                            <span style="background:#e74c3c; color:white; padding:2px 8px; border-radius:10px; font-size:0.8em;">${details.negative_count || 0}</span>
                        </h3>
                        <div style="background:#222; padding:10px; border-radius:10px; max-height:200px; overflow-y:auto;">
                            ${renderSamples(details.negative_samples, 'negative')}
                        </div>
                    </div>
                    
                    <!-- Info Box -->
                    <div style="padding:14px; background:linear-gradient(135deg, #1e3a5f 0%, #1a2a3a 100%); border-radius:10px; font-size:0.8em; border:1px solid #2a4a6a;">
                        <div style="font-weight:bold; color:#5dade2; margin-bottom:8px;">📖 Erklärung:</div>
                        <div style="color:#aaa; line-height:1.6;">
                            <div style="margin-bottom:4px;">✅ <strong style="color:#27ae60;">Positive Samples:</strong> Gesichtsbilder, die dieser Person zugeordnet wurden</div>
                            <div style="margin-bottom:4px;">❌ <strong style="color:#e74c3c;">Negative Samples:</strong> Bilder, die NICHT diese Person zeigen (korrigierte Fehlerkennungen)</div>
                            <div style="margin-bottom:4px;">📊 <strong style="color:#3498db;">Qualitäts-%:</strong> Ähnlichkeit zum Durchschnitt aller Samples (höher = besser)</div>
                            <div style="margin-bottom:4px;">⚠️ <strong style="color:#e74c3c;">Ausreißer:</strong> Samples die stark abweichen - evtl. falsche Person</div>
                            <div>☑️ <strong style="color:#5dade2;">Bulk-Auswahl:</strong> Checkboxen nutzen für Mehrfach-Löschung</div>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(popup);
            
            // Self reference for handlers
            const self = this;
            
            // Close handlers
            popup.querySelector('.close-detail-popup').onclick = () => document.body.removeChild(popup);
            popup.onclick = (e) => { if (e.target === popup) document.body.removeChild(popup); };
            
            // Delete sample handlers
            popup.querySelectorAll('.delete-sample-btn').forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const sampleId = parseInt(btn.getAttribute('data-id'), 10);
                    const sampleType = btn.getAttribute('data-type');
                    
                    if (!confirm(`Sample wirklich löschen?`)) return;
                    
                    try {
                        await self._hass.callWS({
                            type: 'rtsp_recorder/delete_embedding',
                            embedding_id: sampleId,
                            embedding_type: sampleType
                        });
                        
                        self.showToast('Sample gelöscht', 'success');
                        
                        // Refresh the popup
                        document.body.removeChild(popup);
                        await self.refreshPeople();
                        await self.showPersonDetailPopup(personId);
                        
                    } catch (err) {
                        self.showToast('Fehler beim Löschen: ' + (err.message || err), 'error');
                    }
                };
                btn.onmouseover = () => { btn.style.opacity = '1'; btn.style.transform = 'scale(1.1)'; };
                btn.onmouseout = () => { btn.style.opacity = '0.85'; btn.style.transform = 'scale(1)'; };
            });
            
            // v1.2.0: Checkbox handlers for bulk selection
            const bulkActionsDiv = popup.querySelector('#bulk-actions');
            const selectedCountSpan = popup.querySelector('#selected-count');
            
            const updateBulkUI = () => {
                const count = selectedSamples.size;
                if (count > 0) {
                    bulkActionsDiv.style.display = 'block';
                    selectedCountSpan.textContent = count;
                } else {
                    bulkActionsDiv.style.display = 'none';
                }
            };
            
            popup.querySelectorAll('.sample-checkbox').forEach(cb => {
                cb.onchange = (e) => {
                    e.stopPropagation();
                    const id = parseInt(cb.getAttribute('data-id'), 10);
                    const type = cb.getAttribute('data-type');
                    const key = `${type}:${id}`;
                    if (cb.checked) {
                        selectedSamples.add(key);
                        cb.closest('.sample-item').style.boxShadow = '0 0 0 3px #3498db';
                    } else {
                        selectedSamples.delete(key);
                        cb.closest('.sample-item').style.boxShadow = 'none';
                    }
                    updateBulkUI();
                };
            });
            
            // Select all outliers button
            const btnOutliers = popup.querySelector('#btn-select-all-outliers');
            if (btnOutliers) {
                btnOutliers.onclick = () => {
                    popup.querySelectorAll('.sample-item[data-is-outlier="true"]').forEach(item => {
                        const cb = item.querySelector('.sample-checkbox');
                        if (cb && !cb.checked) {
                            cb.checked = true;
                            const id = parseInt(cb.getAttribute('data-id'), 10);
                            const type = cb.getAttribute('data-type');
                            selectedSamples.add(`${type}:${id}`);
                            item.style.boxShadow = '0 0 0 3px #3498db';
                        }
                    });
                    updateBulkUI();
                    self.showToast(`${selectedSamples.size} Ausreißer ausgewählt`, 'info');
                };
            }
            
            // Deselect all button
            const btnDeselect = popup.querySelector('#btn-deselect-all');
            if (btnDeselect) {
                btnDeselect.onclick = () => {
                    popup.querySelectorAll('.sample-checkbox').forEach(cb => {
                        cb.checked = false;
                        cb.closest('.sample-item').style.boxShadow = 'none';
                    });
                    selectedSamples.clear();
                    updateBulkUI();
                };
            }
            
            // Delete selected button
            const btnDeleteSelected = popup.querySelector('#btn-delete-selected');
            if (btnDeleteSelected) {
                btnDeleteSelected.onclick = async () => {
                    const count = selectedSamples.size;
                    if (count === 0) return;
                    
                    if (!confirm(`Wirklich ${count} ausgewählte Samples löschen?`)) return;
                    
                    // Group by type
                    const positiveIds = [];
                    const negativeIds = [];
                    selectedSamples.forEach(key => {
                        const [type, id] = key.split(':');
                        if (type === 'positive') {
                            positiveIds.push(parseInt(id, 10));
                        } else {
                            negativeIds.push(parseInt(id, 10));
                        }
                    });
                    
                    try {
                        let deleted = 0;
                        
                        if (positiveIds.length > 0) {
                            const result = await self._hass.callWS({
                                type: 'rtsp_recorder/bulk_delete_embeddings',
                                embedding_ids: positiveIds,
                                embedding_type: 'positive'
                            });
                            deleted += result.success_count || 0;
                        }
                        
                        if (negativeIds.length > 0) {
                            const result = await self._hass.callWS({
                                type: 'rtsp_recorder/bulk_delete_embeddings',
                                embedding_ids: negativeIds,
                                embedding_type: 'negative'
                            });
                            deleted += result.success_count || 0;
                        }
                        
                        self.showToast(`${deleted} Samples gelöscht`, 'success');
                        
                        // Refresh
                        document.body.removeChild(popup);
                        await self.refreshPeople();
                        await self.showPersonDetailPopup(personId);
                        
                    } catch (err) {
                        self.showToast('Fehler beim Löschen: ' + (err.message || err), 'error');
                    }
                };
            }
            
        } catch (e) {
            this.showToast('Fehler beim Laden: ' + (e.message || e), 'error');
        }
    }

    async loadFaceSamplesForCurrent() {
        this._analysisFaceSamples = [];
        this._enrolledSampleKeys = new Set();
        if (!this._currentEvent) {
            this.showToast('Bitte zuerst eine Aufnahme waehlen', 'warning');
            return;
        }
        this._loadingFaceSamples = true;
        try {
            const data = await this._hass.callWS({
                type: 'rtsp_recorder/get_analysis_result',
                media_id: this._currentEvent.id
            });
            const detections = (data && data.detections) ? data.detections : [];
            const samples = [];
            detections.forEach(d => {
                const time_s = d.time_s;
                const faces = d.faces || [];
                faces.forEach(f => {
                    if (f.embedding) {
                        samples.push({
                            time_s,
                            embedding: f.embedding,
                            match: f.match || null,
                            thumb: f.thumb || null
                        });
                    }
                });
            });
            this._analysisFaceSamples = samples;
            if (!samples.length) {
                this.showToast('Keine Face-Samples gefunden', 'warning');
            } else {
                this.showToast(`Face-Samples geladen: ${samples.length}`, 'success');
            }
        } catch (e) {
            this._analysisFaceSamples = [];
            this.showToast('Analyse konnte nicht geladen werden', 'warning');
        } finally {
            this._loadingFaceSamples = false;
        }
    }

    async analyzeCurrentVideo() {
        if (!this._currentEvent) {
            this.showToast('Bitte zuerst eine Aufnahme auswaehlen', 'warning');
            return;
        }

        const objects = Array.from(this._analysisSelected);
        if (objects.length === 0) {
            this.showToast('Bitte mindestens ein Objekt auswaehlen', 'warning');
            return;
        }

        const root = this.shadowRoot;
        const btnEl = root.querySelector('#btn-analyze');
        const originalText = btnEl ? btnEl.innerHTML : '';

        // Show loading state
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '⏳ Analyse wird gestartet...';
            btnEl.style.opacity = '0.7';
        }

        // Fire-and-forget: Don't await since analysis takes time
        this._hass.callService('rtsp_recorder', 'analyze_recording', {
            media_id: this._currentEvent.id,
            objects,
            device: this._analysisDevice
        }).catch(e => {
            this.showToast('Analyse fehlgeschlagen: ' + e.message, 'error');
            this._restoreSingleAnalysisButton(btnEl, originalText);
        });

        this.showToast('✅ Analyse gestartet!', 'success');
        
        // Start progress polling
        this._startSingleProgressPolling(btnEl, originalText);
    }

    _startSingleProgressPolling(btnEl, originalText) {
        // Clear any existing polling
        if (this._singleProgressPollingInterval) {
            clearInterval(this._singleProgressPollingInterval);
        }
        
        const root = this.shadowRoot;
        const progressContainer = root.querySelector('#single-analysis-progress');
        
        // Show progress container
        if (progressContainer) {
            progressContainer.style.display = 'block';
        }
        
        let startTime = Date.now();
        
        // Poll every 2 seconds
        this._singleProgressPollingInterval = setInterval(async () => {
            try {
                const progress = await this._hass.callWS({
                    type: 'rtsp_recorder/get_single_analysis_progress'
                });
                
                this._updateSingleProgressUI(progress, btnEl, originalText, startTime);
                
                // Stop polling when done
                if (!progress.running && progress.completed) {
                    this._stopSingleProgressPolling(btnEl, originalText, true);
                } else if (!progress.running && !progress.completed && progress.media_id) {
                    // Failed
                    this._stopSingleProgressPolling(btnEl, originalText, false);
                }
            } catch (e) {
                console.error('Single progress polling error:', e);
            }
        }, 2000);
        
        // Safety timeout - stop after 5 minutes
        setTimeout(() => {
            if (this._singleProgressPollingInterval) {
                this._stopSingleProgressPolling(btnEl, originalText, false);
            }
        }, 5 * 60 * 1000);
    }
    
    _updateSingleProgressUI(progress, btnEl, originalText, startTime) {
        const root = this.shadowRoot;
        const progressContainer = root.querySelector('#single-analysis-progress');
        const progressText = root.querySelector('#single-analysis-text');
        const currentBtn = root.querySelector('#btn-analyze');
        
        // Show progress container if found and analysis is running
        if (progressContainer && progress.running) {
            progressContainer.style.display = 'block';
        }
        
        if (progress.running) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            
            // Update button
            const btn = currentBtn || btnEl;
            if (btn) {
                btn.innerHTML = `🔄 Analyse laeuft... (${elapsed}s)`;
                btn.style.background = '#2e7d32';
                btn.disabled = true;
            }
            
            // Update progress text
            if (progressText) {
                const filename = progress.video_path ? progress.video_path.split('/').pop() : 'Video';
                progressText.textContent = `Analysiere: ${filename} (${elapsed}s)`;
            }
        }
    }
    
    _stopSingleProgressPolling(btnEl, originalText, success) {
        if (this._singleProgressPollingInterval) {
            clearInterval(this._singleProgressPollingInterval);
            this._singleProgressPollingInterval = null;
        }
        
        // Show completion message
        if (success) {
            this.showToast('✅ Analyse abgeschlossen!', 'success');
            // Refresh overview
            this.refreshAnalysisOverview();
            // Load detections if overlay enabled
            if (this._overlayEnabled) {
                this.loadDetectionsForCurrentVideo();
            }
        }
        
        this._restoreSingleAnalysisButton(btnEl, originalText);
    }
    
    // v1.1.0: Check and restore single analysis progress on tab switch
    async _checkAndRestoreSingleProgress() {
        // Don't check if already polling
        if (this._singleProgressPollingInterval) {
            return;
        }
        
        try {
            const progress = await this._hass.callWS({
                type: 'rtsp_recorder/get_single_analysis_progress'
            });
            
            if (progress.running) {
                const root = this.shadowRoot;
                const btnEl = root.querySelector('#btn-analyze');
                const originalText = '🔍 Analyse aktuelle Aufnahme';
                
                // Start polling to continue showing progress
                this._startSingleProgressPolling(btnEl, originalText);
            }
        } catch (e) {
            // Silently ignore - progress check is optional
        }
    }

    _restoreSingleAnalysisButton(btnEl, originalText) {
        const root = this.shadowRoot;
        const currentBtn = root.querySelector('#btn-analyze');
        const currentProgress = root.querySelector('#single-analysis-progress');
        
        const btn = currentBtn || btnEl;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText || '🔍 Analyse aktuelle Aufnahme';
            btn.style.opacity = '1';
            btn.style.background = '';
        }
        
        if (currentProgress) {
            currentProgress.style.display = 'none';
        }
    }

    async analyzeAllRecordings() {
        const root = this.shadowRoot;
        const daysEl = root.querySelector('#analysis-days');
        const limitEl = root.querySelector('#analysis-limit');
        const skipEl = root.querySelector('#analysis-skip');
        const btnEl = root.querySelector('#btn-analyze-all');
        const progressContainer = root.querySelector('#analysis-progress-container');

        const since_days = daysEl ? parseInt(daysEl.value || '0', 10) : 0;
        const limit = limitEl ? parseInt(limitEl.value || '0', 10) : 0;
        const skip_existing = skipEl ? skipEl.checked : true;
        const objects = Array.from(this._analysisSelected);

        if (objects.length === 0) {
            this.showToast('Bitte mindestens ein Objekt auswaehlen', 'warning');
            return;
        }

        // Visual feedback - disable button and show loading
        const originalText = btnEl ? btnEl.innerHTML : '';
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '⏳ Analyse wird gestartet...';
            btnEl.style.opacity = '0.7';
        }

        // Fire-and-forget: Don't await the service call since it's long-running
        this._hass.callService('rtsp_recorder', 'analyze_all_recordings', {
            since_days,
            limit,
            skip_existing,
            objects,
            device: this._analysisDevice
        }).catch(e => {
            console.error('[RTSP] Service call failed:', e);
            this.showToast('❌ Analyse fehlgeschlagen: ' + e.message, 'error');
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = originalText || 'Alle Aufnahmen analysieren';
                btnEl.style.opacity = '1';
            }
        });
        
        this.showToast('✅ Analyse gestartet!', 'success');
        
        // Start progress polling immediately
        this._startProgressPolling(btnEl, originalText);
    }

    _startProgressPolling(btnEl, originalText) {
        // v1.2.3: Progress updates now come via PUSH events (rtsp_recorder_batch_progress)
        // This function only handles:
        // 1. Initial UI setup
        // 2. Stats polling for TPU load display (every 2s during analysis)
        
        // Clear any existing polling
        if (this._progressPollingInterval) {
            clearInterval(this._progressPollingInterval);
        }
        
        const root = this.shadowRoot;
        const progressContainer = root.querySelector('#analysis-progress-container');
        
        // Show progress container immediately
        if (progressContainer) {
            progressContainer.style.display = 'block';
        }
        
        // Set initial "preparing" state
        const progressText = root.querySelector('#analysis-progress-text');
        if (progressText) {
            progressText.textContent = 'Analyse wird vorbereitet...';
        }
        
        // v1.2.3: Only poll stats for TPU load display - progress comes via PUSH
        this._progressPollingInterval = setInterval(() => {
            this.fetchDetectorStats();
            this.updatePerfFooter();
        }, 2000);
        
        // Safety timeout - stop stats polling after 30 minutes
        setTimeout(() => {
            if (this._progressPollingInterval) {
                clearInterval(this._progressPollingInterval);
                this._progressPollingInterval = null;
            }
        }, 30 * 60 * 1000);
    }
    
    _updateProgressUI(progress, btnEl, originalText, progressContainerParam) {
        const root = this.shadowRoot;
        // Always re-query DOM elements in case tab was re-rendered
        const progressContainer = root.querySelector('#analysis-progress-container');
        const progressBar = root.querySelector('#analysis-progress-bar');
        const progressText = root.querySelector('#analysis-progress-text');
        const currentBtn = root.querySelector('#btn-analyze-all');
        
        // Show progress container if found and analysis is running
        if (progressContainer && progress.running) {
            progressContainer.style.display = 'block';
        }
        
        if (progress.running && progress.total > 0) {
            const percent = Math.round((progress.current / progress.total) * 100);
            
            // Update button (use current button from DOM if available)
            const btn = currentBtn || btnEl;
            if (btn) {
                btn.innerHTML = `🔄 Analyse laeuft... (${progress.current}/${progress.total})`;
                btn.style.background = '#2e7d32';
                btn.disabled = true;
            }
            
            // Update progress bar
            if (progressBar) {
                progressBar.style.width = percent + '%';
            }
            if (progressText) {
                const fileInfo = progress.current_file ? ` - ${progress.current_file}` : '';
                progressText.textContent = `${progress.current} von ${progress.total} analysiert (${percent}%)${fileInfo}`;
            }
        } else if (!progress.running && progress.current > 0) {
            // Completed
            if (progressBar) {
                progressBar.style.width = '100%';
                progressBar.style.background = '#4caf50';
            }
            if (progressText) {
                progressText.textContent = `✅ Fertig: ${progress.current} Aufnahmen analysiert`;
            }
        }
    }
    
    // v1.2.3: Helper to reset batch UI after completion (used by PUSH event handler)
    _stopBatchUI(btnEl, progressContainerParam) {
        const root = this.shadowRoot;
        const currentBtn = root.querySelector('#btn-analyze-all');
        const progressContainer = root.querySelector('#analysis-progress-container');
        
        // Restore button
        const btn = currentBtn || btnEl;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Alle Aufnahmen analysieren';
            btn.style.opacity = '1';
            btn.style.background = '';
            // v1.2.3: Reset onclick to original handler (was changed to stop handler during analysis)
            btn.onclick = null;
        }
        
        // Hide progress container
        const pc = progressContainer || progressContainerParam;
        if (pc) {
            pc.style.display = 'none';
        }
        
        // Reset progress bar
        const progressBar = root.querySelector('#analysis-progress-bar');
        if (progressBar) {
            progressBar.style.width = '0%';
            progressBar.style.background = '#2196f3';
        }
        
        // Refresh overview to show new analyses
        this.refreshAnalysisOverview();
    }
    
    // v1.2.3: Stop running batch analysis
    async _stopBatchAnalysis() {
        try {
            const result = await this._hass.callWS({
                type: 'rtsp_recorder/stop_batch_analysis'
            });
            if (result.success) {
                this.showToast('⏹️ Stopp angefordert...', 'info');
                // Button deaktivieren während abgebrochen wird
                const btn = this.shadowRoot.querySelector('#btn-analyze-all');
                if (btn) {
                    btn.disabled = true;
                    btn.innerHTML = '⏳ Wird gestoppt...';
                }
            }
        } catch (e) {
            console.error('Stop batch analysis error:', e);
            this.showToast('⚠️ Stopp fehlgeschlagen', 'error');
        }
    }
    
    _stopProgressPolling(btnEl, originalText, progressContainerParam, progress) {
        if (this._progressPollingInterval) {
            clearInterval(this._progressPollingInterval);
            this._progressPollingInterval = null;
        }
        
        // Show completion message
        if (progress && progress.current > 0) {
            this.showToast(`✅ Analyse abgeschlossen: ${progress.current} Aufnahmen`, 'success');
        }
        
        const root = this.shadowRoot;
        // Always re-query DOM elements
        const currentBtn = root.querySelector('#btn-analyze-all');
        const progressContainer = root.querySelector('#analysis-progress-container');
        
        // Restore button (use current button from DOM if available)
        const btn = currentBtn || btnEl;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText || 'Alle Aufnahmen analysieren';
            btn.style.opacity = '1';
            btn.style.background = '';
        }
        
        // Hide progress after delay
        setTimeout(() => {
            const pc = this.shadowRoot.querySelector('#analysis-progress-container');
            if (pc) {
                pc.style.display = 'none';
            }
            // Reset progress bar
            const progressBar = this.shadowRoot.querySelector('#analysis-progress-bar');
            if (progressBar) {
                progressBar.style.width = '0%';
                progressBar.style.background = '#2196f3';
            }
        }, 3000);
        
        // Refresh overview to show new analyses
        this.refreshAnalysisOverview();
    }

    async refreshAnalysisOverview(page = null) {
        if (this._analysisLoading) return;
        this._analysisLoading = true;
        
        // Use specified page or current page
        const targetPage = page !== null ? page : this._analysisPage;
        
        try {
            const data = await this._hass.callWS({
                type: 'rtsp_recorder/get_analysis_overview',
                page: targetPage,
                per_page: this._analysisPerPage
            });
            this._analysisOverview = data || { items: [], stats: {} };
            
            // Update pagination state
            this._analysisPage = data.page || 1;
            this._analysisTotalPages = data.total_pages || 1;
            this._analysisTotal = data.total || 0;
            
            this._perfSensors = (data && data.perf) ? data.perf : { cpu: null, igpu: null, coral: null };
            this.updatePerfFooter();
            this._analysisDeviceOptions = (data && data.devices)
                ? data.devices.map(d => ({ value: d, label: d === 'coral_usb' ? 'Coral USB' : d.toUpperCase() }))
                : null;
            if (this._analysisDeviceOptions && this._analysisDeviceOptions.length) {
                const values = this._analysisDeviceOptions.map(o => o.value);
                if (!values.includes(this._analysisDevice)) {
                    this._analysisDevice = values[0];
                }
            }
            this._analysisOverviewLoaded = true;
        } catch (e) {
            this._analysisOverview = { items: [], stats: {} };
        } finally {
            this._analysisLoading = false;
            if (this._activeTab === 'analysis') {
                this.renderAnalysisTab(this.shadowRoot.querySelector('#menu-content'));
            } else if (this._activeTab === 'performance') {
                this.renderPerformanceTab(this.shadowRoot.querySelector('#menu-content'));
            }
        }
    }
    
    async goToAnalysisPage(page) {
        if (page < 1 || page > this._analysisTotalPages) return;
        await this.refreshAnalysisOverview(page);
    }

    async loadDetectionsForCurrentVideo() {
        if (!this._currentEvent || !this._overlayEnabled) return;
        // v1.2.0: Reset overlay cache when loading new video
        this._lastOverlayKey = null;
        this._lastOverlaySize = null;
        this._overlayCtx = null;  // v1.2.0: Reset cached context
        this._detectionsIndex = null;  // v1.2.0: Reset index
        try {
            const data = await this._hass.callWS({
                type: 'rtsp_recorder/get_analysis_result',
                media_id: this._currentEvent.id
            });
            if (data && data.detections) {
                this._analysisDetections = data.detections;
                this._analysisInterval = data.frame_interval || 2;
                this._analysisFrameSize = {
                    width: data.frame_width || null,
                    height: data.frame_height || null
                };
                // v1.2.3: Store video FPS from analysis data for accurate display
                this._videoFps = data.video_fps || null;
                // v1.2.0: Build index for O(1) frame lookup (instead of Array.find)
                this._detectionsIndex = {};
                for (const d of data.detections) {
                    this._detectionsIndex[d.time_s] = d;
                }
                this.drawOverlay();
            } else {
                this._analysisDetections = null;
                this.clearOverlay();
            }
        } catch (e) {
            this._analysisDetections = null;
            this.clearOverlay();
        }
    }

    resizeOverlay() {
        const canvas = this.shadowRoot.querySelector('#overlay-canvas');
        const video = this.shadowRoot.querySelector('#main-video');
        if (!canvas || !video) return;
        canvas.width = video.clientWidth;
        canvas.height = video.clientHeight;
    }

    clearOverlay() {
        const canvas = this.shadowRoot.querySelector('#overlay-canvas');
        if (!canvas) return;
        // v1.2.0: Use cached context if available
        const ctx = this._overlayCtx || canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // v1.2.0: Reset index on clear
        this._detectionsIndex = null;
        // v1.2.0: Stop smoothing loop and clear smoothed boxes
        this._stopSmoothingLoop();
        this._smoothedBoxes = new Map();
    }

    updateOverlayStates() {
        const btn = this.shadowRoot.querySelector('#btn-overlay');
        if (btn) btn.classList.toggle('active', this._overlayEnabled);

        const footerToggle = this.shadowRoot.querySelector('#footer-overlay');
        if (footerToggle) footerToggle.checked = !!this._overlayEnabled;

        const menuToggle = this.shadowRoot.querySelector('#analysis-overlay');
        if (menuToggle) menuToggle.checked = !!this._overlayEnabled;
    }

    async fetchDetectorStats() {
        if (!this._hass) return;
        try {
            const result = await this._hass.callWS({ type: 'rtsp_recorder/get_detector_stats' });
            console.log('[RTSP-Recorder] Detector Stats Result:', JSON.stringify(result, null, 2));
            this._detectorStats = result;
            
            // Get system stats from our component (reads /proc directly)
            this._liveStats = {};
            const sysStats = result.system_stats || {};
            if (sysStats.cpu_percent != null) {
                this._liveStats.cpu = { state: sysStats.cpu_percent, unit: '%', name: 'CPU' };
            }
            if (sysStats.memory_percent != null) {
                this._liveStats.memory = { state: sysStats.memory_percent, unit: '%', name: 'RAM' };
            }
            this._liveStats.memoryMb = sysStats.memory_used_mb || 0;
            this._liveStats.memoryTotalMb = sysStats.memory_total_mb || 0;
            
            // Add to history for graphs
            if (this._liveStats.cpu) {
                this._statsHistory.push({
                    time: Date.now(),
                    cpu: this._liveStats.cpu.state,
                    memory: this._liveStats.memory?.state || 0
                });
                if (this._statsHistory.length > this._maxHistoryPoints) {
                    this._statsHistory.shift();
                }
            }
            
            // v1.1.0: Fetch analysis progress for live status
            try {
                const singleProgress = await this._hass.callWS({ type: 'rtsp_recorder/get_single_analysis_progress' });
                const batchProgress = await this._hass.callWS({ type: 'rtsp_recorder/get_analysis_progress' });
                const oldRunning = this._analysisProgress?.single?.running;
                const newRunning = singleProgress?.running;
                
                this._analysisProgress = {
                    single: singleProgress,
                    batch: batchProgress
                };
                console.log('[RTSP-Recorder] Analysis Progress:', JSON.stringify(this._analysisProgress));
                
                // v1.1.0: DON'T call updateView() here - it disrupts the progress display
                // The progress is shown in updatePerfFooter() which is called after this
            } catch (e) {
                console.warn('[RTSP-Recorder] Failed to fetch analysis progress:', e);
                this._analysisProgress = null;
            }
            
            // v1.1.0: Fetch recording progress for live status
            try {
                const recordingProgress = await this._hass.callWS({ type: 'rtsp_recorder/get_recording_progress' });
                const oldRecording = this._recordingProgress?.running;
                const newRecording = recordingProgress?.running;
                
                this._recordingProgress = recordingProgress;
                
                // Update timeline if recording status changed
                if (oldRecording !== newRecording) {
                    this.updateView();
                }
            } catch (e) {
                this._recordingProgress = null;
            }
            
            this.updatePerfFooter();
            
            // Update performance tab if open
            if (this._activeTab === 'performance') {
                this.renderPerformanceTab(this.shadowRoot.querySelector('#menu-content'));
            }
        } catch (e) {
            console.warn('Failed to fetch detector stats:', e);
        }
    }

    // v1.2.3: Stats polling entfernt - alle Updates kommen via PUSH events
    startStatsPolling() {
        // Initial fetch only - main updates come via rtsp_recorder_stats_update event
        this.fetchDetectorStats();
    }

    stopStatsPolling() {
        // No-op - no polling to stop anymore
    }

    updatePerfFooter() {
        const panel = this.shadowRoot.querySelector('#footer-perf-panel');
        if (!panel) return;

        if (!this._showPerfPanel) {
            panel.innerHTML = '';
            return;
        }

        const stats = this._detectorStats || {};
        const live = this._liveStats || {};
        const tracker = stats.inference_stats || {};
        const devices = stats.devices || [];
        const hasCoralUsb = devices.includes('coral_usb');
        // v1.2.3: Prefer HA host stats, fallback to detector stats and legacy HA sensors
        const hostStats = stats.system_stats_ha || {};
        const sysStats = stats.system_stats || {};

        // CPU - prefer detector stats, fallback to HA sensor
        let cpuValue = 'n/a';
        let cpuColor = '#888';
        const cpuPct = hostStats.cpu ?? sysStats.cpu_percent ?? live.cpu?.state;
        if (cpuPct != null) {
            cpuValue = cpuPct.toFixed(1) + '%';
            cpuColor = cpuPct > 80 ? '#f44336' : cpuPct > 50 ? '#ff9800' : '#4caf50';
        }

        // Memory - prefer detector stats, fallback to HA sensor
        let memValue = 'n/a';
        let memColor = '#888';
        const memPct = hostStats.memory ?? sysStats.memory_percent ?? live.memory?.state;
        if (memPct != null) {
            memValue = memPct.toFixed(1) + '%';
            memColor = memPct > 80 ? '#f44336' : memPct > 60 ? '#ff9800' : '#4caf50';
        }

        const hasInf = tracker.total_inferences > 0;
        const ipm = tracker.inferences_per_minute ?? 0;
        const avgMs = tracker.avg_inference_ms ?? 0;
        const fallbackSecs = this._lastInferenceAt ? (Date.now() - this._lastInferenceAt) / 1000 : -1;
        const secsSinceLastInf = tracker.seconds_since_last_inference ?? fallbackSecs;
        // Zeige 0% wenn länger als 3s keine Inferenz (Fallback: IPM)
        const hasRealtime = secsSinceLastInf >= 0;
        const isActive = hasRealtime ? secsSinceLastInf < 3 : ipm > 0;
        const inferenceMsDisplay = hasInf ? (isActive && avgMs > 0 ? `${avgMs.toFixed(0)}ms` : '0ms') : '-';

        // Coral device status
        let coralHtml = '';
        if (hasCoralUsb) {
            // v1.2.2: Use coral_inferences > 0 instead of last_device to prevent jumping status
            const coralActive = tracker.coral_inferences > 0;
            const coralPct = tracker.recent_coral_pct ?? tracker.coral_usage_pct ?? 0;
            const coralDisplay = hasInf ? `${Math.round(coralPct)}%` : '-';
            const coralColor = !hasInf
                ? '#666'
                : coralPct > 50
                    ? '#4caf50'
                    : coralPct > 0
                        ? '#ff9800'
                        : '#666';
            
            // v1.2.3: TPU Load - Echtzeit: 0% wenn keine Inferenz in letzten 3 Sekunden
            const tpuLoad = isActive ? Math.min(100, Math.round((ipm * avgMs) / 600)) : 0;
            const tpuLoadDisplay = hasInf ? `${Math.round(tpuLoad)}%` : '-';
            // Farbkodierung: <5% grün, 5-25% orange, >25% rot
            const tpuLoadColor = !hasInf
                ? '#666'
                : tpuLoad > 25
                    ? '#f44336'
                    : tpuLoad > 5
                        ? '#ff9800'
                        : '#4caf50';
            
            coralHtml = `
                <div class="fm-perf-card">
                    <div class="fm-perf-label">Coral USB</div>
                    <div class="fm-perf-value" style="color: ${coralActive ? '#4caf50' : '#888'}">
                        ${coralActive ? 'Aktiv' : 'Bereit'}
                    </div>
                </div>
                <div class="fm-perf-card" title="Coral Anteil: Prozent der Inferenzen auf Coral (vs CPU)">
                    <div class="fm-perf-label">Coral Anteil</div>
                    <div class="fm-perf-value" style="color: ${coralColor}">
                        ${coralDisplay}
                    </div>
                </div>
                <div class="fm-perf-card" title="TPU Last: Wie viel der TPU-Zeit ist mit Inferenzen belegt (60s Fenster)">
                    <div class="fm-perf-label">TPU Last</div>
                    <div class="fm-perf-value" style="color: ${tpuLoadColor}">
                        ${tpuLoadDisplay}
                    </div>
                </div>
            `;
        } else {
            coralHtml = `
                <div class="fm-perf-card">
                    <div class="fm-perf-label">Coral USB</div>
                    <div class="fm-perf-value" style="color: #666">Nicht verbunden</div>
                </div>
            `;
        }

        // Inference stats
        let inferenceHtml = '';
        // v1.1.0m: Coral stats shown inline, no hint needed
        if (tracker.total_inferences > 0) {
            inferenceHtml = `
                <div class="fm-perf-card">
                    <div class="fm-perf-label">Inferenz</div>
                    <div class="fm-perf-value">${inferenceMsDisplay}</div>
                </div>
                <div class="fm-perf-card">
                    <div class="fm-perf-label">Gesamt</div>
                    <div class="fm-perf-value">${tracker.total_inferences}</div>
                </div>
            `;
        }
        // v1.1.0m: Removed inferenceHint - unnecessary, stats only show when active anyway

        // v1.1.0c: Analysis progress moved to footer-analysis-status (always visible)
        // Removed from here to avoid duplicate display

        panel.innerHTML = `
            <div class="fm-perf-card">
                <div class="fm-perf-label">CPU</div>
                <div class="fm-perf-value" style="color: ${cpuColor}">${cpuValue}</div>
            </div>
            <div class="fm-perf-card">
                <div class="fm-perf-label">RAM</div>
                <div class="fm-perf-value" style="color: ${memColor}">${memValue}</div>
            </div>
            ${coralHtml}
            ${inferenceHtml}
        `;
    }

    // v1.2.3: Update professional frame timecode overlay
    _updateFrameInfo() {
        const root = this.shadowRoot;
        if (!root) return;
        
        const video = root.querySelector('#main-video');
        const frameInfo = root.querySelector('#txt-frame-info');
        if (!video || !frameInfo) return;
        
        // Only show when video is loaded and playing
        if (!video.videoWidth || video.readyState < 2) {
            frameInfo.classList.remove('visible');
            return;
        }
        
        frameInfo.classList.add('visible');
        
        const t = video.currentTime;
        const duration = video.duration || 0;
        
        // v1.2.3: Use video FPS from analysis data (stored from ffprobe)
        // Show "?" if no analysis data available (FPS unknown)
        const hasFps = this._videoFps !== null && this._videoFps > 0;
        const fps = hasFps ? this._videoFps : 20;  // Use 20 as estimate for frame display only
        
        // Calculate current frame number based on video FPS
        const frameNum = Math.floor(t * fps);
        const totalFrames = Math.floor(duration * fps);
        
        // Format timecode: HH:MM:SS:FF (SMPTE style)
        const hours = Math.floor(t / 3600);
        const mins = Math.floor((t % 3600) / 60);
        const secs = Math.floor(t % 60);
        const frames = Math.floor((t % 1) * fps);
        
        const timecode = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
        
        // v1.2.3: Show actual FPS from ffprobe, or "?" if unknown
        const fpsDisplay = hasFps ? (Number.isInteger(fps) ? fps : fps.toFixed(1)) : '?';
        
        // Update display
        frameInfo.innerHTML = `<span style="color:#0f0">${timecode}</span> | <span style="color:#ff0">${fpsDisplay} FPS</span> | <span style="color:#0ff">F${frameNum}/${totalFrames}</span>`;
    }

    // v1.2.0: Schedule overlay update - throttled to reduce CPU load
    _scheduleOverlayUpdate() {
        // v1.2.3: Always update frame info when video is playing
        this._updateFrameInfo();
        
        // v1.2.0: Quick bail-out before RAF if we know nothing changed
        if (!this._overlayEnabled || !this._analysisDetections) {
            return;
        }
        
        const video = this.shadowRoot.querySelector('#main-video');
        if (!video || !video.videoWidth) {
            return;
        }
        
        // v1.2.0: If smoothing is enabled, run continuous animation loop
        if (this._overlaySmoothingEnabled) {
            if (!this._smoothingRAF) {
                this._startSmoothingLoop();
            }
            return;
        }
        
        // v1.2.0: Pre-check if frame changed BEFORE scheduling RAF
        const t = video.currentTime;
        const key = Math.floor(t / this._analysisInterval) * this._analysisInterval;
        if (this._lastOverlayKey === key && this._lastOverlaySize === `${video.clientWidth}x${video.clientHeight}`) {
            return; // Skip RAF entirely - same frame
        }
        
        // Use requestAnimationFrame for smooth updates synced to display refresh
        if (this._overlayRAF) {
            cancelAnimationFrame(this._overlayRAF);
        }
        this._overlayRAF = requestAnimationFrame(() => this.drawOverlay());
    }

    // v1.2.0: Continuous animation loop for smooth box interpolation
    _startSmoothingLoop() {
        if (this._smoothingRAF) return;
        
        const animate = (timestamp) => {
            if (!this._overlayEnabled || !this._overlaySmoothingEnabled) {
                this._smoothingRAF = null;
                this._lastSmoothTime = null;
                return;
            }
            
            // Calculate delta time for frame-rate independent smoothing
            const deltaTime = this._lastSmoothTime ? (timestamp - this._lastSmoothTime) / 1000 : 0.016;
            this._lastSmoothTime = timestamp;
            
            this.drawOverlaySmoothed(deltaTime);
            this._smoothingRAF = requestAnimationFrame(animate);
        };
        
        this._smoothingRAF = requestAnimationFrame(animate);
    }

    // v1.2.0: Stop smoothing animation loop
    _stopSmoothingLoop() {
        if (this._smoothingRAF) {
            cancelAnimationFrame(this._smoothingRAF);
            this._smoothingRAF = null;
        }
        this._lastSmoothTime = null;
    }

    drawOverlay() {
        if (!this._overlayEnabled || !this._analysisDetections) return;
        const canvas = this.shadowRoot.querySelector('#overlay-canvas');
        const video = this.shadowRoot.querySelector('#main-video');
        if (!canvas || !video || !video.videoWidth) return;

        // v1.2.0: Throttle overlay drawing - only redraw when frame changes
        const t = video.currentTime;
        const key = Math.floor(t / this._analysisInterval) * this._analysisInterval;
        const sizeKey = `${video.clientWidth}x${video.clientHeight}`;
        
        // v1.2.0: Skip if same frame AND same size (prevents redundant redraws)
        if (this._lastOverlayKey === key && this._lastOverlaySize === sizeKey) {
            return; // Same frame, no need to redraw
        }
        
        const sizeChanged = this._lastOverlaySize !== sizeKey;
        this._lastOverlayKey = key;
        this._lastOverlaySize = sizeKey;

        // v1.2.0: Only resize canvas when size actually changed (avoids costly reflow)
        if (sizeChanged) {
            canvas.width = video.clientWidth;
            canvas.height = video.clientHeight;
            // Invalidate cached context when canvas resizes
            this._overlayCtx = null;
        }

        // v1.2.0: Cache canvas context (avoid getContext call every frame)
        if (!this._overlayCtx) {
            this._overlayCtx = canvas.getContext('2d');
        }
        const ctx = this._overlayCtx;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const frameSize = this._analysisFrameSize || { width: video.videoWidth, height: video.videoHeight };
        const fw = frameSize.width || video.videoWidth;
        const fh = frameSize.height || video.videoHeight;

        const containerW = video.clientWidth;
        const containerH = video.clientHeight;
        const videoAspect = video.videoWidth / video.videoHeight;
        const containerAspect = containerW / containerH;

        let drawW, drawH, offsetX, offsetY;
        if (videoAspect > containerAspect) {
            drawW = containerW;
            drawH = containerW / videoAspect;
            offsetX = 0;
            offsetY = (containerH - drawH) / 2;
        } else {
            drawH = containerH;
            drawW = containerH * videoAspect;
            offsetY = 0;
            offsetX = (containerW - drawW) / 2;
        }

        const scaleX = drawW / fw;
        const scaleY = drawH / fh;

        // v1.2.0: Use indexed lookup instead of Array.find() for O(1) access
        const frame = this._detectionsIndex ? this._detectionsIndex[key] 
            : this._analysisDetections.find(d => d.time_s === key);
        if (!frame || (!frame.objects && !frame.faces)) return;

        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 2;
        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#00e5ff';

        (frame.objects || []).forEach(obj => {
            const box = obj.box;
            const x = offsetX + box.x * scaleX;
            const y = offsetY + box.y * scaleY;
            const w = box.w * scaleX;
            const h = box.h * scaleY;
            ctx.strokeStyle = '#00e5ff';
            ctx.fillStyle = '#00e5ff';
            ctx.strokeRect(x, y, w, h);
            const label = `${obj.label} ${Math.round(obj.score * 100)}%`;
            ctx.fillText(label, x + 2, y - 4);
        });

        (frame.faces || []).forEach(face => {
            const box = face.box;
            const x = offsetX + box.x * scaleX;
            const y = offsetY + box.y * scaleY;
            const w = box.w * scaleX;
            const h = box.h * scaleY;
            ctx.strokeStyle = '#ff9800';
            ctx.fillStyle = '#ff9800';
            ctx.strokeRect(x, y, w, h);
            // Fix: Use match.similarity for recognized faces, face.score for unknown
            const matchName = face.match && face.match.name ? face.match.name : 'Unbekannt';
            const score = face.match && face.match.similarity != null 
                ? Math.round(face.match.similarity * 100) + '%' 
                : (face.score != null ? Math.round(face.score * 100) + '%' : '');
            const label = score ? `${matchName} ${score}` : matchName;
            ctx.fillText(label, x + 2, y - 4);
        });
    }

    // v1.2.0: Smoothed overlay drawing with interpolation
    drawOverlaySmoothed(deltaTime) {
        if (!this._overlayEnabled || !this._analysisDetections) return;
        const canvas = this.shadowRoot.querySelector('#overlay-canvas');
        const video = this.shadowRoot.querySelector('#main-video');
        if (!canvas || !video || !video.videoWidth) return;

        const sizeKey = `${video.clientWidth}x${video.clientHeight}`;
        const sizeChanged = this._lastOverlaySize !== sizeKey;
        this._lastOverlaySize = sizeKey;

        if (sizeChanged) {
            canvas.width = video.clientWidth;
            canvas.height = video.clientHeight;
            this._overlayCtx = null;
        }

        if (!this._overlayCtx) {
            this._overlayCtx = canvas.getContext('2d');
        }
        const ctx = this._overlayCtx;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const frameSize = this._analysisFrameSize || { width: video.videoWidth, height: video.videoHeight };
        const fw = frameSize.width || video.videoWidth;
        const fh = frameSize.height || video.videoHeight;

        const containerW = video.clientWidth;
        const containerH = video.clientHeight;
        const videoAspect = video.videoWidth / video.videoHeight;
        const containerAspect = containerW / containerH;

        let drawW, drawH, offsetX, offsetY;
        if (videoAspect > containerAspect) {
            drawW = containerW;
            drawH = containerW / videoAspect;
            offsetX = 0;
            offsetY = (containerH - drawH) / 2;
        } else {
            drawH = containerH;
            drawW = containerH * videoAspect;
            offsetY = 0;
            offsetX = (containerW - drawW) / 2;
        }

        const scaleX = drawW / fw;
        const scaleY = drawH / fh;

        // Get current frame's detections
        const t = video.currentTime;
        const key = Math.floor(t / this._analysisInterval) * this._analysisInterval;
        const frame = this._detectionsIndex ? this._detectionsIndex[key] 
            : this._analysisDetections.find(d => d.time_s === key);
        
        if (!frame || (!frame.objects && !frame.faces)) {
            this._smoothedBoxes = {}; // Reset when no detections
            return;
        }

        // Lerp factor based on delta time and alpha setting
        // Higher alpha = faster interpolation
        const lerpFactor = 1 - Math.pow(1 - this._overlaySmoothingAlpha, deltaTime * 60);

        ctx.lineWidth = 2;
        ctx.font = '12px sans-serif';

        // Helper function for exponential smoothing
        const lerp = (current, target, factor) => current + (target - current) * factor;

        // Draw objects with smoothing
        (frame.objects || []).forEach((obj, idx) => {
            const boxId = `obj_${idx}_${obj.label}`;
            const targetBox = {
                x: offsetX + obj.box.x * scaleX,
                y: offsetY + obj.box.y * scaleY,
                w: obj.box.w * scaleX,
                h: obj.box.h * scaleY
            };

            // Initialize or update smoothed position
            if (!this._smoothedBoxes[boxId]) {
                this._smoothedBoxes[boxId] = { ...targetBox };
            } else {
                const sb = this._smoothedBoxes[boxId];
                sb.x = lerp(sb.x, targetBox.x, lerpFactor);
                sb.y = lerp(sb.y, targetBox.y, lerpFactor);
                sb.w = lerp(sb.w, targetBox.w, lerpFactor);
                sb.h = lerp(sb.h, targetBox.h, lerpFactor);
            }

            const box = this._smoothedBoxes[boxId];
            ctx.strokeStyle = '#00e5ff';
            ctx.fillStyle = '#00e5ff';
            ctx.strokeRect(box.x, box.y, box.w, box.h);
            const label = `${obj.label} ${Math.round(obj.score * 100)}%`;
            ctx.fillText(label, box.x + 2, box.y - 4);
        });

        // Draw faces with smoothing
        (frame.faces || []).forEach((face, idx) => {
            const matchName = face.match && face.match.name ? face.match.name : 'Unbekannt';
            const boxId = `face_${idx}_${matchName}`;
            const targetBox = {
                x: offsetX + face.box.x * scaleX,
                y: offsetY + face.box.y * scaleY,
                w: face.box.w * scaleX,
                h: face.box.h * scaleY
            };

            if (!this._smoothedBoxes[boxId]) {
                this._smoothedBoxes[boxId] = { ...targetBox };
            } else {
                const sb = this._smoothedBoxes[boxId];
                sb.x = lerp(sb.x, targetBox.x, lerpFactor);
                sb.y = lerp(sb.y, targetBox.y, lerpFactor);
                sb.w = lerp(sb.w, targetBox.w, lerpFactor);
                sb.h = lerp(sb.h, targetBox.h, lerpFactor);
            }

            const box = this._smoothedBoxes[boxId];
            ctx.strokeStyle = '#ff9800';
            ctx.fillStyle = '#ff9800';
            ctx.strokeRect(box.x, box.y, box.w, box.h);
            const score = face.match && face.match.similarity != null 
                ? Math.round(face.match.similarity * 100) + '%' 
                : (face.score != null ? Math.round(face.score * 100) + '%' : '');
            const label = score ? `${matchName} ${score}` : matchName;
            ctx.fillText(label, box.x + 2, box.y - 4);
        });

        // Cleanup old smoothed boxes that are no longer in frame
        const currentBoxIds = new Set();
        (frame.objects || []).forEach((obj, idx) => currentBoxIds.add(`obj_${idx}_${obj.label}`));
        (frame.faces || []).forEach((face, idx) => {
            const matchName = face.match && face.match.name ? face.match.name : 'Unbekannt';
            currentBoxIds.add(`face_${idx}_${matchName}`);
        });
        Object.keys(this._smoothedBoxes).forEach(id => {
            if (!currentBoxIds.has(id)) {
                delete this._smoothedBoxes[id];
            }
        });
    }

    async renderStorageTab(container) {
        container.innerHTML = '<div style="text-align:center;color:#888;padding:40px;">Lade Speicherinfo...</div>';
        
        // Calculate from events
        const totalEvents = this._events ? this._events.length : 0;
        
        // Group by camera
        const camCounts = {};
        if (this._events) {
            this._events.forEach(e => {
                camCounts[e.cam] = (camCounts[e.cam] || 0) + 1;
            });
        }
        
        // Get today's recordings
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const todayCount = this._events ? this._events.filter(e => e.iso === todayStr).length : 0;
        
        // Build camera breakdown
        const camBreakdown = Object.entries(camCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([cam, count]) => `
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #333;">
                    <span>${cam.replace(/_/g, ' ')}</span>
                    <span style="color:var(--primary-color);font-weight:500;">${count}</span>
                </div>
            `).join('');
        
        container.innerHTML = `
            <div style="padding:10px;">
                <div class="fm-storage-stats">
                    <div class="fm-stat-card">
                        <div class="fm-stat-value">${totalEvents}</div>
                        <div class="fm-stat-label">Aufnahmen gesamt</div>
                    </div>
                    <div class="fm-stat-card">
                        <div class="fm-stat-value">${todayCount}</div>
                        <div class="fm-stat-label">Heute</div>
                    </div>
                    <div class="fm-stat-card">
                        <div class="fm-stat-value">${Object.keys(camCounts).length}</div>
                        <div class="fm-stat-label">Kameras</div>
                    </div>
                    <div class="fm-stat-card">
                        <div class="fm-stat-value">~${(totalEvents * 0.05).toFixed(1)}</div>
                        <div class="fm-stat-label">GB geschaetzt</div>
                    </div>
                </div>
                
                <div style="margin-top:25px;">
                    <div style="font-weight:500;margin-bottom:10px;">Aufnahmen pro Kamera</div>
                    ${camBreakdown || '<div style="color:#888;">Keine Daten</div>'}
                </div>
                
                <button class="fm-btn-danger" id="btn-refresh-storage" style="margin-top:20px;">
                    Aktualisieren
                </button>
                
                <!-- Lösch-Bereich -->
                <div style="margin-top:30px;padding-top:20px;border-top:1px solid #444;">
                    <div style="font-weight:500;margin-bottom:15px;color:#e74c3c;">🗑️ Aufnahmen löschen</div>
                    
                    <div style="display:flex;flex-direction:column;gap:12px;">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <label style="min-width:120px;">Kamera:</label>
                            <select id="delete-camera" style="flex:1;padding:8px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;">
                                <option value="">Alle Kameras</option>
                                ${Object.keys(camCounts).map(cam => `<option value="${cam}">${cam.replace(/_/g, ' ')}</option>`).join('')}
                            </select>
                        </div>
                        
                        <div style="display:flex;align-items:center;gap:10px;">
                            <label style="min-width:120px;">Älter als:</label>
                            <select id="delete-age" style="flex:1;padding:8px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;">
                                <option value="0">Alle (kein Filter)</option>
                                <option value="1">Älter als 1 Tag</option>
                                <option value="3">Älter als 3 Tage</option>
                                <option value="7">Älter als 1 Woche</option>
                                <option value="14">Älter als 2 Wochen</option>
                                <option value="30">Älter als 1 Monat</option>
                                <option value="90">Älter als 3 Monate</option>
                            </select>
                        </div>
                        
                        <div style="display:flex;align-items:center;gap:10px;">
                            <label style="min-width:120px;"></label>
                            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                                <input type="checkbox" id="delete-analysis" style="width:18px;height:18px;">
                                <span>Auch Analysen löschen</span>
                            </label>
                        </div>
                    </div>
                    
                    <div style="margin-top:20px;display:flex;gap:10px;">
                        <button class="fm-btn-danger" id="btn-delete-preview" style="flex:1;background:#555;">
                            👁️ Vorschau
                        </button>
                        <button class="fm-btn-danger" id="btn-delete-all" style="flex:1;background:#c0392b;">
                            🗑️ Löschen
                        </button>
                    </div>
                    
                    <div id="delete-result" style="margin-top:15px;padding:10px;border-radius:4px;display:none;"></div>
                </div>
            </div>
        `;
        
        container.querySelector('#btn-refresh-storage').onclick = () => {
            this.loadData();
            this.renderStorageTab(container);
        };
        
        // Delete Preview Button
        container.querySelector('#btn-delete-preview').onclick = async () => {
            const camera = container.querySelector('#delete-camera').value;
            const age = parseInt(container.querySelector('#delete-age').value);
            const includeAnalysis = container.querySelector('#delete-analysis').checked;
            const resultDiv = container.querySelector('#delete-result');
            
            // Count affected files
            let affectedCount = 0;
            const cutoffDate = age > 0 ? new Date(Date.now() - age * 24 * 60 * 60 * 1000) : null;
            
            if (this._events) {
                this._events.forEach(e => {
                    if (camera && e.cam !== camera) return;
                    if (cutoffDate && e.date >= cutoffDate) return;
                    affectedCount++;
                });
            }
            
            resultDiv.style.display = 'block';
            resultDiv.style.background = '#2c3e50';
            resultDiv.innerHTML = `
                <div style="font-weight:500;margin-bottom:5px;">📊 Vorschau:</div>
                <div>• ${affectedCount} Aufnahme(n) würden gelöscht</div>
                ${includeAnalysis ? '<div>• Zugehörige Analysen würden auch gelöscht</div>' : ''}
                ${camera ? `<div>• Nur Kamera: ${camera.replace(/_/g, ' ')}</div>` : '<div>• Alle Kameras</div>'}
                ${age > 0 ? `<div>• Älter als ${age} Tag(e)</div>` : '<div>• Alle Aufnahmen (kein Altersfilter!)</div>'}
            `;
        };
        
        // Delete Button
        container.querySelector('#btn-delete-all').onclick = async () => {
            const camera = container.querySelector('#delete-camera').value;
            const age = parseInt(container.querySelector('#delete-age').value);
            const includeAnalysis = container.querySelector('#delete-analysis').checked;
            const resultDiv = container.querySelector('#delete-result');
            
            // Confirmation dialog
            const msg = camera 
                ? `Wirklich alle Aufnahmen von "${camera.replace(/_/g, ' ')}" löschen?`
                : 'Wirklich ALLE Aufnahmen löschen?';
            
            if (!confirm(msg + (age === 0 ? '\n\n⚠️ ACHTUNG: Kein Altersfilter gesetzt!' : ''))) {
                return;
            }
            
            resultDiv.style.display = 'block';
            resultDiv.style.background = '#2c3e50';
            resultDiv.innerHTML = '<div style="text-align:center;">🔄 Lösche Aufnahmen...</div>';
            
            try {
                await this._hass.callService('rtsp_recorder', 'delete_all_recordings', {
                    camera: camera || undefined,
                    older_than_days: age,
                    include_analysis: includeAnalysis,
                    confirm: true
                });
                
                resultDiv.style.background = '#27ae60';
                resultDiv.innerHTML = `
                    <div style="font-weight:500;">✅ Erfolgreich gelöscht!</div>
                    <div style="margin-top:5px;">Aktualisiere Ansicht...</div>
                `;
                
                // Reload data after 1 second
                setTimeout(() => {
                    this.loadData();
                    this.renderStorageTab(container);
                }, 1000);
                
            } catch (e) {
                resultDiv.style.background = '#c0392b';
                resultDiv.innerHTML = `
                    <div style="font-weight:500;">❌ Fehler:</div>
                    <div>${e.message || 'Unbekannter Fehler'}</div>
                `;
            }
        };
    }

    _toMediaSourcePath(basePath) {
        if (!basePath || !basePath.startsWith('/media/')) return null;
        const rel = basePath.replace(/^\/media\//, '');
        return `media-source://media_source/local/${rel}`;
    }

    async loadData() {
        console.log('[RTSP-Recorder] loadData() called at', new Date().toISOString());
        const hass = this._hass;
        const path = this._toMediaSourcePath(this._basePath);
        if (!path) {
            this.shadowRoot.querySelector('#list').innerHTML = `<div style="padding:20px;color:red;">Fehler: Base-Pfad muss mit /media/ beginnen. (base_path: ${this._escapeHtml(this._basePath)})</div>`;
            return;
        }
        try {
            const root = await hass.callWS({ type: 'media_source/browse_media', media_content_id: path });
            let events = [];
            if (root && root.children) {
                for (const folder of root.children) {
                    if (folder.media_class !== 'directory') continue;
                    if (folder.title === '_analysis') continue;
                    const res = await hass.callWS({ type: 'media_source/browse_media', media_content_id: folder.media_content_id });
                    if (res.children) {
                        res.children.forEach(f => {
                            const parts = f.title.match(/(\d{8})_(\d{6})/);
                            if (parts) {
                                const d = parts[1], t = parts[2];
                                const dt = new Date(`${d.substr(0, 4)}-${d.substr(4, 2)}-${d.substr(6, 2)}T${t.substr(0, 2)}:${t.substr(2, 2)}:${t.substr(4, 2)}`);
                                events.push({
                                    id: f.media_content_id,
                                    date: dt,
                                    cam: folder.title,
                                    iso: `${d.substr(0, 4)}-${d.substr(4, 2)}-${d.substr(6, 2)}`,
                                    thumb: `${this._thumbBase}/${folder.title}/${f.title.replace(/\.mp4$/i, '.jpg')}`
                                });
                            }
                        });
                    }
                }
            }
            this._events = events.sort((a, b) => b.date - a.date);
            console.log('[RTSP-Recorder] loadData() completed with', events.length, 'events at', new Date().toISOString());
            this.updateView();
        } catch (e) {
            // MED-010 Fix: Detailed error messages with troubleshooting hints
            let errorDetail = e.message || 'Unbekannter Fehler';
            let hint = '';
            
            if (errorDetail.includes('not found') || errorDetail.includes('404')) {
                hint = '<br><small>💡 Prüfe ob der Pfad existiert und die Integration korrekt konfiguriert ist.</small>';
            } else if (errorDetail.includes('permission') || errorDetail.includes('403')) {
                hint = '<br><small>💡 Berechtigungsfehler - prüfe die Dateiberechtigungen.</small>';
            } else if (errorDetail.includes('timeout') || errorDetail.includes('network')) {
                hint = '<br><small>💡 Netzwerkfehler - prüfe die Verbindung zu Home Assistant.</small>';
            } else if (errorDetail.includes('media_source')) {
                hint = '<br><small>💡 Media Source nicht verfügbar - stelle sicher dass die Integration geladen ist.</small>';
            }
            
            rtspError('loadData failed:', e);
            this.shadowRoot.querySelector('#list').innerHTML = `<div style="padding:20px;color:red;">Fehler beim Laden: ${this._escapeHtml(errorDetail)}${hint}<br><small style="color:#666;">Pfad: ${this._escapeHtml(this._basePath)}</small></div>`;
        }
    }

    updateView() {
        const root = this.shadowRoot;
        const list = root.querySelector('#list');
        const ruler = root.querySelector('#ruler');
        if (!list || !ruler) return;
        list.innerHTML = ''; ruler.innerHTML = '';

        // v1.1.0: Recording status is now updated separately via _updateRecordingStatusOnly()
        // This prevents timeline from "zapping" during recording progress polls

        let filtered = this._events || [];
        if (this._selectedDate) filtered = filtered.filter(e => e.iso === this._selectedDate);
        else filtered = filtered.filter(e => e.date > new Date(Date.now() - 24 * 60 * 60 * 1000));
        if (this._selectedCam !== 'Alle') filtered = filtered.filter(e => e.cam === this._selectedCam);

        if (filtered.length === 0) { list.innerHTML = `<div style="padding:20px;color:#888;text-align:center;">Keine Aufnahmen.</div>`; return; }

        // v1.1.0g: Get ALL currently analyzing video paths for marking (supports parallel analyses)
        const progress = this._analysisProgress;
        const analyses = (progress && progress.single && progress.single.analyses) || [];
        const analyzingPaths = analyses.filter(a => a.running).map(a => a.video_path);

        let index = 0;
        filtered.forEach(ev => {
            const time = ev.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            // Render Tick with staggered animation
            const tick = document.createElement('div'); tick.className = 'fm-tick';
            if (this._animationsEnabled) {
                tick.style.animationDelay = `${index * 0.05}s`;
            }
            tick.innerHTML = `<span class="fm-tick-label">${time}</span>`;
            ruler.appendChild(tick);

            // v1.1.0g: Check if this item is being analyzed (supports multiple parallel analyses)
            const videoFilename = ev.id.split('/').pop(); // Get filename from media_content_id
            const isAnalyzing = analyzingPaths.some(path => path && path.includes(videoFilename));

            // Render Item with staggered animation
            const item = document.createElement('div'); 
            item.className = isAnalyzing ? 'fm-item analyzing' : 'fm-item';
            if (this._animationsEnabled) {
                item.style.animationDelay = `${index * 0.05}s`;
            }
            const displayName = ev.cam.replace(/_/g, ' ');

            // v1.1.0: Add status badge for analyzing videos
            const statusBadge = isAnalyzing ? `<div class="fm-badge-analyzing">🔄 Analyse</div>` : '';

            item.innerHTML = `
                <div class="fm-thumb-wrap">
                    <img src="${this._escapeHtml(ev.thumb)}" class="fm-thumb-img" onerror="this.style.display='none'">
                    ${statusBadge}
                    <div class="fm-badge-cam">${this._escapeHtml(displayName)}</div>
                    <div class="fm-badge-time">${this._escapeHtml(time)}</div>
                </div>
                <div class="fm-item-info">
                    <div class="fm-item-cam">${this._escapeHtml(displayName)}</div>
                    <div class="fm-item-time">${this._escapeHtml(time)}</div>
                </div>
            `;
            item.onclick = async () => {
                root.querySelectorAll('.fm-item').forEach(x => x.classList.remove('selected'));
                item.classList.add('selected');
                
                // Store current event for download/delete
                this._currentEvent = ev;
                
                // v1.2.3: Reset cached video FPS on video change
                this._videoFps = null;
                
                const video = root.querySelector('#main-video');
                const loadingSpinner = root.querySelector('#video-loading-spinner');
                
                // v1.3.2: Show loading spinner and poster for better mobile UX
                if (loadingSpinner) loadingSpinner.style.display = 'flex';
                video.poster = ev.thumb; // Use thumbnail as poster while loading
                
                // Add loading state for smooth transition
                if (this._animationsEnabled) {
                    video.classList.add('loading');
                }
                
                try {
                    // v1.3.3: Use custom video endpoint with Range support for mobile
                    // Extract camera and filename from media_content_id
                    // Format: media-source://media_source/local/rtsp_recordings/Camera/File.mp4
                    const idParts = ev.id.split('/');
                    const videoFilename = idParts.pop(); // File.mp4
                    const videoCamera = idParts.pop();   // Camera
                    
                    // Prefer our custom endpoint (proper Range/206 support for mobile)
                    // Falls back to media_source if custom endpoint fails
                    let videoUrl;
                    try {
                        const directUrl = `/api/rtsp_recorder/video/${encodeURIComponent(videoCamera)}/${encodeURIComponent(videoFilename)}`;
                        // Quick HEAD check to verify endpoint works
                        const check = await fetch(directUrl, { method: 'HEAD', credentials: 'same-origin' });
                        if (check.ok || check.status === 206) {
                            videoUrl = directUrl;
                            console.log('[RTSP-Recorder] Using direct video endpoint:', directUrl);
                        } else {
                            throw new Error(`Direct endpoint returned ${check.status}`);
                        }
                    } catch (directErr) {
                        // Fallback to media_source/resolve_media
                        console.warn('[RTSP-Recorder] Direct endpoint unavailable, falling back to media_source:', directErr.message);
                        const info = await this._hass.callWS({ type: 'media_source/resolve_media', media_content_id: ev.id });
                        videoUrl = info.url;
                    }
                    
                    this._currentVideoUrl = videoUrl;
                    
                    // v1.3.2: Use canplay event for mobile - ensures enough data buffered
                    video.oncanplay = () => {
                        if (loadingSpinner) loadingSpinner.style.display = 'none';
                        if (this._animationsEnabled) {
                            video.classList.remove('loading');
                        }
                        video.play().catch(e => console.warn('[RTSP-Recorder] Autoplay blocked:', e));
                    };
                    
                    // Fallback timeout for slow connections
                    video.onerror = () => {
                        if (loadingSpinner) loadingSpinner.style.display = 'none';
                        console.error('[RTSP-Recorder] Video load error');
                    };
                    
                    video.src = videoUrl;
                    video.load(); // Explicitly start loading
                } catch (e) {
                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                    console.error('[RTSP-Recorder] Failed to resolve media:', e);
                }
                
                root.querySelector('#txt-cam').innerText = displayName;
                root.querySelector('#txt-date').innerText = ev.date.toLocaleString('de-DE');
                if (this._overlayEnabled) {
                    this.loadDetectionsForCurrentVideo();
                }
            };
            list.appendChild(item);
            index++;
        });
        
        // v1.1.0h: Robuster: Nach Timeline-Rebuild immer Status wiederherstellen
        this._restoreStatusIndicators();
    }
    
    // v1.1.0h: Zentrale Methode zum Wiederherstellen aller Status-Anzeigen nach Timeline-Updates
    _restoreStatusIndicators() {
        // 1. Footer-Sichtbarkeit
        this.updateFooterVisibility();
        
        // 2. v1.2.4: Recording-Status aus _runningRecordings Map (event-driven)
        // War: _updateRecordingStatusOnly() - verwendet alten _recordingProgress Cache
        this._updateRecordingUI();
        
        // 3. v1.2.3: Analyse-Status direkt aus _runningAnalyses Map (event-driven)
        // NICHT aus _analysisProgress Cache - das verursachte Race Conditions
        setTimeout(() => this._updateAnalysisUI(), 100);
    }

    renderCalendar() {
        const grid = this.shadowRoot.querySelector('#cal-grid');
        const lbl = this.shadowRoot.querySelector('#cal-month-year');
        if (!grid || !lbl) return;
        const months = ["Januar", "Februar", "Maerz", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
        lbl.innerText = `${months[this._calMonth]} ${this._calYear}`;
        grid.innerHTML = '';
        const firstDay = new Date(this._calYear, this._calMonth, 1).getDay();
        const daysInMonth = new Date(this._calYear, this._calMonth + 1, 0).getDate();
        let startOffset = firstDay === 0 ? 6 : firstDay - 1;
        for (let i = 0; i < startOffset; i++) grid.innerHTML += `<div class="fm-cal-day"></div>`;
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        for (let d = 1; d <= daysInMonth; d++) {
            const iso = `${this._calYear}-${String(this._calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const el = document.createElement('div'); el.className = 'fm-cal-day'; el.innerText = d;
            if (iso === todayStr) el.classList.add('today');
            if (iso === this._selectedDate) el.classList.add('selected');
            el.onclick = () => { this._selectedDate = iso; this.updateDateLabel(); this.togglePopup(); this.renderCalendar(); };
            grid.appendChild(el);
        }
    }

    // ========== DOWNLOAD ==========
    async downloadCurrentVideo() {
        if (!this._currentVideoUrl || !this._currentEvent) {
            this.showToast('Bitte zuerst eine Aufnahme auswaehlen', 'warning');
            return;
        }
        
        const filename = `${this._currentEvent.cam}_${this._currentEvent.iso}_${this._currentEvent.date.toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'}).replace(':','-')}.mp4`;
        
        // Try modern File System Access API (Chrome/Edge) for "Save As" dialog
        if ('showSaveFilePicker' in window) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'Video Datei',
                        accept: { 'video/mp4': ['.mp4'] }
                    }]
                });
                
                this.showToast('Download laeuft...', 'info');
                
                // Fetch the video
                const response = await fetch(this._currentVideoUrl);
                const blob = await response.blob();
                
                // Write to selected file
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                
                this.showToast('Download abgeschlossen!', 'success');
                return;
            } catch (e) {
                // User cancelled or API failed - fall through to standard download
                if (e.name === 'AbortError') {
                    return; // User cancelled
                }
                console.warn('Save dialog failed, using standard download:', e);
            }
        }
        
        // Fallback: Standard download (goes to Downloads folder)
        const a = document.createElement('a');
        a.href = this._currentVideoUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        this.showToast('Download gestartet (Standard-Ordner)', 'success');
    }

    // ========== DELETE ==========
    showDeleteConfirm() {
        if (!this._currentEvent) {
            this.showToast('Bitte zuerst eine Aufnahme auswaehlen', 'warning');
            return;
        }
        const filename = `${this._currentEvent.cam} - ${this._currentEvent.date.toLocaleString('de-DE')}`;
        this.shadowRoot.querySelector('#confirm-filename').innerText = filename;
        this.shadowRoot.querySelector('#confirm-overlay').classList.add('open');
    }

    hideDeleteConfirm() {
        this.shadowRoot.querySelector('#confirm-overlay').classList.remove('open');
    }

    async deleteCurrentVideo() {
        if (!this._currentEvent) return;
        
        try {
            // Call HA service to delete the file
            await this._hass.callService('rtsp_recorder', 'delete_recording', {
                media_id: this._currentEvent.id
            });
            
            // Remove from local list
            this._events = this._events.filter(e => e.id !== this._currentEvent.id);
            this._currentEvent = null;
            this._currentVideoUrl = null;
            
            // Clear video
            const video = this.shadowRoot.querySelector('#main-video');
            video.src = '';
            this.shadowRoot.querySelector('#txt-cam').innerText = 'Waehle Aufnahme';
            this.shadowRoot.querySelector('#txt-date').innerText = 'Geloescht';
            
            this.hideDeleteConfirm();
            this.updateView();
            this.showToast('Aufnahme geloescht', 'success');
        } catch (e) {
            console.error('Delete failed:', e);
            this.showToast('Fehler beim Loeschen: ' + e.message, 'error');
            this.hideDeleteConfirm();
        }
    }

    // ========== TOAST NOTIFICATIONS ==========
    showToast(message, type = 'info') {
        const existing = this.shadowRoot.querySelector('.fm-toast');
        if (existing) existing.remove();
        
        const colors = {
            success: '#4caf50',
            warning: '#ff9800',
            error: '#f44336',
            info: '#03a9f4'
        };
        
        const toast = document.createElement('div');
        toast.className = 'fm-toast';
        toast.style.cssText = `
            position: absolute;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: ${colors[type]};
            color: #fff;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 500;
            z-index: 5000;
            animation: fadeInUp 0.3s ease-out;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        `;
        toast.innerText = message;
        this.shadowRoot.querySelector('#container').appendChild(toast);
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ========== STORAGE INFO ==========
    async loadStorageInfo() {
        try {
            const result = await this._hass.callService('rtsp_recorder', 'get_storage_info', {}, true);
            return result;
        } catch (e) {
            // Fallback: estimate from events
            const totalEvents = this._events ? this._events.length : 0;
            const estimatedSize = totalEvents * 50; // ~50MB per recording estimate
            return {
                used_gb: (estimatedSize / 1024).toFixed(1),
                total_gb: 'N/A',
                percent: 0,
                recordings: totalEvents
            };
        }
    }

    // ===== v1.4.0: per-camera & delete config tabs (added to the card menu) =====
    _pcFields() {
        return [
            { key: "analysis_objects", label: "🎯 Objekte", kind: "list" },
            { key: "analysis_detector_confidence", label: "📊 Erkennungs-Schwelle", kind: "float", min: 0.1, max: 0.9, step: 0.05, zeroIsGlobal: true },
            { key: "analysis_face_confidence", label: "👁️ Gesichts-Erkennungsschwelle", kind: "float", min: 0.1, max: 0.8, step: 0.05, zeroIsGlobal: true },
            { key: "analysis_face_match_threshold", label: "🎚️ Gesichts-Matching-Schwelle", kind: "float", min: 0.2, max: 0.9, step: 0.05, zeroIsGlobal: true },
            { key: "analysis_frame_interval", label: "⏱️ Frame-Intervall (Sek)", kind: "int", min: 1, max: 10, step: 1 },
            { key: "analysis_face_enabled", label: "👤 Gesichtserkennung", kind: "bool" },
            { key: "analysis_face_multiscale", label: "🔍 Multi-Scale", kind: "bool" },
            { key: "analysis_overlay_smoothing", label: "Overlay-Glättung", kind: "bool" },
        ];
    }
    _pcBaseFields() {
        return [
            { key: "camera_enabled", label: "🎥 Auto-Aufnahme bei Bewegung", kind: "bool" },
            { key: "motion_sensors", label: "🏃 Auslöser-Sensoren (Komma-getrennt)", kind: "list" },
            { key: "recording_duration", label: "⏱️ Aufnahmedauer (Sek)", kind: "int", min: 10, max: 600, step: 10 },
            { key: "snapshot_delay", label: "📸 Snapshot-Verzögerung (Sek)", kind: "int", min: 0, max: 60, step: 1 },
            { key: "rtsp_url", label: "🔗 RTSP-URL", kind: "text" },
            { key: "camera_retention", label: "🗑️ Eigene Aufbewahrung (Std, 0=global)", kind: "float", min: 0, max: 168, step: 0.5 },
        ];
    }
    async _pcLoadAll() {
        try { const res = await this._hass.callWS({ type: "rtsp_recorder/get_cameras" }); this._pcCameras = (res && res.cameras) || []; }
        catch (e) { this._pcCameras = []; }
        if (!this._pcSelected && this._pcCameras.length) this._pcSelected = this._pcCameras[0].key;
        try { const g = await this._hass.callWS({ type: "rtsp_recorder/get_global_settings" }); this._pcGlobals = (g && g.settings) || {}; }
        catch (e) { this._pcGlobals = {}; }
        await this._pcLoadCam();
        this._pcLoaded = true;
    }
    async _pcLoadCam() {
        if (!this._pcSelected) { this._pcData = null; this._pcBase = {}; return; }
        try { const r = await this._hass.callWS({ type: "rtsp_recorder/get_camera_settings", camera: this._pcSelected }); this._pcData = r && r.success ? r : null; }
        catch (e) { this._pcData = null; }
        try { const b = await this._hass.callWS({ type: "rtsp_recorder/get_camera_base", camera: this._pcSelected }); this._pcBase = b && b.success ? (b.base || {}) : {}; }
        catch (e) { this._pcBase = {}; }
    }
    _pcRefresh() {
        setTimeout(async () => {
            try { const res = await this._hass.callWS({ type: "rtsp_recorder/get_cameras" }); this._pcCameras = (res && res.cameras) || []; } catch (e) {}
            try { const g = await this._hass.callWS({ type: "rtsp_recorder/get_global_settings" }); this._pcGlobals = (g && g.settings) || {}; } catch (e) {}
            await this._pcLoadCam();
            const c = this.shadowRoot.querySelector('#menu-content');
            if (c && this._activeTab === 'percamera') this.renderPerCameraTab(c);
            if (c && this._activeTab === 'delete') this.renderDeleteTab(c);
        }, 600);
    }
    renderPerCameraTab(container) {
        if (!this._pcLoaded) {
            container.innerHTML = `<div style="padding:20px;color:#888;">Lade Kameras…</div>`;
            this._pcLoadAll().then(() => { if (this._activeTab === 'percamera') this.renderPerCameraTab(container); });
            return;
        }
        const head = "margin:18px 0 8px;font-size:0.95em;color:#bbb;font-weight:500;";
        if (!this._pcCameras.length) {
            container.innerHTML = `<div style="padding:14px;"><div style="color:#888;margin-bottom:14px;">Keine konfigurierten Kameras. Füge unten eine hinzu.</div>${this._pcAddCardHtml(head)}</div>`;
            this._pcWireAdd(container);
            return;
        }
        const opts = this._pcCameras.map(c => `<option value="${this._pcEsc(c.key)}" ${c.key === this._pcSelected ? 'selected' : ''}>${this._pcEsc(c.name)}</option>`).join("");
        const eff = (this._pcData && this._pcData.effective) || {};
        const ov = (this._pcData && this._pcData.overrides) || {};
        const base = this._pcBase || {};
        const baseRows = this._pcBaseFields().map(f => this._pcRow(f, base[f.key], "b")).join("");
        const anRows = this._pcFields().map(f => this._pcCamRow(f, eff[f.key], (f.key in ov), (this._pcGlobals || {})[f.key])).join("");
        container.innerHTML = `<div style="padding:14px;">
            <div style="background:rgba(255,152,0,0.14);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:0.88em;line-height:1.4;">Einstellungen <b>nur für die gewählte Kamera</b>. „Global" = diese Kamera nutzt den globalen Standardwert (Tab „Analyse").</div>
            <label style="font-weight:500;">Kamera</label>
            <select id="pc-cam" style="width:100%;margin:6px 0 4px;padding:8px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">${opts}</select>
            <h4 style="${head}">🎥 Aufnahme-Einstellungen</h4>${baseRows}
            <button id="pc-base-save" style="margin-top:10px;padding:8px 16px;background:var(--primary-color,#03a9f4);color:#fff;border:none;border-radius:6px;cursor:pointer;">Aufnahme-Einstellungen speichern</button>
            <h4 style="${head}">🧠 Analyse pro Kamera <span style="color:#888;font-weight:400;">(speichert sofort)</span></h4>${anRows}
            ${this._pcAddCardHtml(head)}
        </div>`;
        container.querySelector('#pc-cam').addEventListener('change', async (e) => { this._pcSelected = e.target.value; await this._pcLoadCam(); this.renderPerCameraTab(container); });
        container.querySelector('#pc-base-save').addEventListener('click', () => this._pcSaveBase(container));
        this._pcFields().forEach(f => this._pcWire(container, f, (f.key in ov)));
        this._pcWireAdd(container);
    }
    _pcRow(f, value, ns) {
        return `<div style="margin:8px 0;"><label style="display:block;font-size:0.9em;margin-bottom:3px;">${f.label}</label>${this._pcInput(f, value, ns)}</div>`;
    }
    _pcCamRow(f, eff, isOv, glob) {
        const badge = isOv
            ? `<span style="font-size:0.7em;background:var(--primary-color,#03a9f4);color:#fff;padding:1px 6px;border-radius:8px;">eigen</span>`
            : `<span style="font-size:0.7em;background:#333;color:#aaa;padding:1px 6px;border-radius:8px;">global: ${this._pcEsc(this._pcFmt(glob))}</span>`;
        let ctrl;
        if (f.kind === 'bool') {
            const cur = isOv ? (eff ? 'on' : 'off') : 'global';
            ctrl = `<select class="pc-an" data-f="${f.key}" style="padding:6px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;"><option value="global" ${cur === 'global' ? 'selected' : ''}>Global</option><option value="on" ${cur === 'on' ? 'selected' : ''}>An</option><option value="off" ${cur === 'off' ? 'selected' : ''}>Aus</option></select>`;
        } else if (f.kind === 'list') {
            const v = isOv && Array.isArray(eff) ? eff.join(", ") : "";
            ctrl = `<input type="text" class="pc-an" data-f="${f.key}" placeholder="(global)" value="${this._pcEsc(v)}" style="width:100%;padding:6px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">`;
        } else {
            const num = isOv ? eff : (glob ?? f.min ?? 0);
            ctrl = `<label style="font-size:0.85em;"><input type="checkbox" class="pc-anchk" data-f="${f.key}" ${isOv ? 'checked' : ''}> eigen</label> <input type="number" class="pc-annum" data-f="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${num}" ${isOv ? '' : 'disabled'} style="width:90px;padding:6px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">`;
        }
        return `<div style="margin:8px 0;"><label style="display:block;font-size:0.9em;margin-bottom:3px;">${f.label} ${badge}</label>${ctrl}</div>`;
    }
    _pcWire(container, f, isOv) {
        if (f.kind === 'bool') {
            const s = container.querySelector(`select.pc-an[data-f="${f.key}"]`);
            s.addEventListener('change', () => this._pcSetSetting(f.key, s.value === 'global' ? null : s.value === 'on'));
        } else if (f.kind === 'list') {
            const i = container.querySelector(`input.pc-an[data-f="${f.key}"]`);
            i.addEventListener('change', () => this._pcSetSetting(f.key, i.value.split(",").map(x => x.trim()).filter(Boolean)));
        } else {
            const chk = container.querySelector(`input.pc-anchk[data-f="${f.key}"]`);
            const num = container.querySelector(`input.pc-annum[data-f="${f.key}"]`);
            chk.addEventListener('change', () => { num.disabled = !chk.checked; this._pcSetSetting(f.key, chk.checked ? this._pcCoerce(f, num.value) : (f.zeroIsGlobal ? 0 : null)); });
            num.addEventListener('change', () => { if (chk.checked) this._pcSetSetting(f.key, this._pcCoerce(f, num.value)); });
        }
    }
    async _pcSetSetting(field, value) {
        if (!this._pcSelected || this._pcBusy) return;
        this._pcBusy = true;
        try { const r = await this._hass.callWS({ type: "rtsp_recorder/set_camera_setting", camera: this._pcSelected, field, value }); if (!r || !r.success) throw new Error((r && r.message) || "Fehler"); this.showToast('Gespeichert', 'success'); this._pcRefresh(); }
        catch (e) { this.showToast('⚠️ ' + e.message, 'error'); }
        finally { this._pcBusy = false; }
    }
    async _pcSaveBase(container) {
        if (!this._pcSelected || this._pcBusy) return;
        const msg = { type: "rtsp_recorder/set_camera_base", camera: this._pcSelected };
        this._pcBaseFields().forEach(f => { const v = this._pcRead(container, f, "b"); if (v !== undefined) msg[f.key] = v; });
        this._pcBusy = true;
        try { const r = await this._hass.callWS(msg); if (!r || !r.success) throw new Error((r && r.message) || "Fehler"); this.showToast('Aufnahme-Einstellungen gespeichert', 'success'); this._pcRefresh(); }
        catch (e) { this.showToast('⚠️ ' + e.message, 'error'); }
        finally { this._pcBusy = false; }
    }
    _pcAddCardHtml(head) {
        return `<h4 style="${head}">➕ Neue Kamera hinzufügen</h4>
            <input type="text" id="pc-add-name" placeholder="Kamera-Name (z.B. Garage)" style="width:100%;margin:4px 0;padding:7px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">
            <input type="text" id="pc-add-url" placeholder="rtsp://..." style="width:100%;margin:4px 0;padding:7px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">
            <input type="text" id="pc-add-sensors" placeholder="Sensoren (optional, Komma-getrennt)" style="width:100%;margin:4px 0;padding:7px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">
            <button id="pc-add-btn" style="margin-top:8px;padding:8px 16px;background:#2e7d32;color:#fff;border:none;border-radius:6px;cursor:pointer;">Kamera hinzufügen</button>`;
    }
    _pcWireAdd(container) { const b = container.querySelector('#pc-add-btn'); if (b) b.addEventListener('click', () => this._pcAddCamera(container)); }
    async _pcAddCamera(container) {
        if (this._pcBusy) return;
        const name = (container.querySelector('#pc-add-name').value || "").trim();
        const url = (container.querySelector('#pc-add-url').value || "").trim();
        const sensors = (container.querySelector('#pc-add-sensors').value || "").split(",").map(x => x.trim()).filter(Boolean);
        if (!name || !url) { this.showToast('Name und RTSP-URL nötig', 'warning'); return; }
        const msg = { type: "rtsp_recorder/add_camera", camera_name: name, rtsp_url: url };
        if (sensors.length) msg.motion_sensors = sensors;
        this._pcBusy = true;
        try { const r = await this._hass.callWS(msg); if (!r || !r.success) throw new Error((r && r.message) || "Fehler"); this.showToast(`Kamera „${name}" hinzugefügt`, 'success'); this._pcSelected = r.camera; this._pcRefresh(); }
        catch (e) { this.showToast('⚠️ ' + e.message, 'error'); }
        finally { this._pcBusy = false; }
    }
    renderDeleteTab(container) {
        if (!this._pcLoaded) {
            container.innerHTML = `<div style="padding:20px;color:#888;">Lade…</div>`;
            this._pcLoadAll().then(() => { if (this._activeTab === 'delete') this.renderDeleteTab(container); });
            return;
        }
        if (!this._pcCameras.length) { container.innerHTML = `<div style="padding:20px;color:#888;">Keine Kameras zum Löschen.</div>`; return; }
        const opts = this._pcCameras.map(c => `<option value="${this._pcEsc(c.key)}" ${c.key === this._pcSelected ? 'selected' : ''}>${this._pcEsc(c.name)}</option>`).join("");
        container.innerHTML = `<div style="padding:14px;">
            <div style="background:rgba(244,67,54,0.14);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:0.88em;line-height:1.4;">Entfernt die <b>Konfiguration</b> einer Kamera (Sensoren, Dauer, RTSP, Analyse-Overrides). <b>Aufnahmen auf der Platte bleiben.</b></div>
            <label style="font-weight:500;">Kamera</label>
            <select id="del-cam" style="width:100%;margin:6px 0 14px;padding:8px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">${opts}</select>
            <div id="del-area">${this._pcDelArmed
                ? `<button id="del-confirm" style="padding:8px 16px;background:#c62828;color:#fff;border:none;border-radius:6px;cursor:pointer;">Wirklich löschen: „${this._pcEsc(this._pcName(this._pcSelected))}"</button> <button id="del-cancel" style="margin-left:8px;padding:8px 16px;background:#333;color:#eee;border:none;border-radius:6px;cursor:pointer;">Abbrechen</button>`
                : `<button id="del-arm" style="padding:8px 16px;background:transparent;border:1px solid #c62828;color:#ef9a9a;border-radius:6px;cursor:pointer;">Kamera-Konfiguration löschen…</button>`}</div>
        </div>`;
        container.querySelector('#del-cam').addEventListener('change', (e) => { this._pcSelected = e.target.value; this._pcDelArmed = false; this.renderDeleteTab(container); });
        if (this._pcDelArmed) {
            container.querySelector('#del-confirm').addEventListener('click', () => this._pcDelete(container));
            container.querySelector('#del-cancel').addEventListener('click', () => { this._pcDelArmed = false; this.renderDeleteTab(container); });
        } else {
            container.querySelector('#del-arm').addEventListener('click', () => { this._pcDelArmed = true; this.renderDeleteTab(container); });
        }
    }
    async _pcDelete(container) {
        const cam = this._pcSelected;
        if (!cam || this._pcBusy) return;
        this._pcBusy = true;
        try { const r = await this._hass.callWS({ type: "rtsp_recorder/delete_camera", camera: cam }); if (!r || !r.success) throw new Error((r && r.message) || "Löschen fehlgeschlagen"); this.showToast(`Kamera „${this._pcName(cam)}" gelöscht`, 'success'); this._pcDelArmed = false; this._pcSelected = null; this._pcRefresh(); }
        catch (e) { this.showToast('⚠️ ' + e.message, 'error'); }
        finally { this._pcBusy = false; }
    }
    _pcInput(f, value, ns) {
        if (f.kind === 'bool') return `<label><input type="checkbox" class="pc-${ns}" data-f="${f.key}" ${value === true ? 'checked' : ''}> aktiv</label>`;
        if (f.kind === 'list') { const v = Array.isArray(value) ? value.join(", ") : (value || ""); return `<input type="text" class="pc-${ns}" data-f="${f.key}" value="${this._pcEsc(v)}" style="width:100%;padding:6px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">`; }
        if (f.kind === 'text') { const v = value == null ? "" : String(value); return `<input type="text" class="pc-${ns}" data-f="${f.key}" value="${this._pcEsc(v)}" style="width:100%;padding:6px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">`; }
        const num = value ?? f.min ?? 0; return `<input type="number" class="pc-${ns}" data-f="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${num}" style="width:120px;padding:6px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;">`;
    }
    _pcRead(container, f, ns) {
        const el = container.querySelector(`.pc-${ns}[data-f="${f.key}"]`);
        if (!el) return undefined;
        if (f.kind === 'bool') return el.checked;
        if (f.kind === 'text') return el.value;
        if (f.kind === 'list') return el.value.split(",").map(x => x.trim()).filter(Boolean);
        return this._pcCoerce(f, el.value);
    }
    _pcCoerce(f, raw) { return f.kind === 'int' ? parseInt(raw, 10) : parseFloat(raw); }
    _pcEsc(s) { return s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    _pcFmt(v) { if (v == null) return "—"; if (Array.isArray(v)) return v.length ? v.join(", ") : "—"; if (typeof v === 'boolean') return v ? 'an' : 'aus'; return String(v); }
    _pcName(key) { const c = (this._pcCameras || []).find(x => x.key === key); return c ? c.name : (key || ""); }
    _pcGlobalSettingsFields() {
        return [
            { key: "storage_path", label: "📁 Speicherpfad", kind: "text" },
            { key: "snapshot_path", label: "📸 Thumbnail-Pfad", kind: "text" },
            { key: "retention_days", label: "🎬 Video-Aufbewahrung (Tage)", kind: "int", min: 1, max: 365, step: 1 },
            { key: "snapshot_retention_days", label: "📸 Thumbnail-Aufbewahrung (Tage)", kind: "int", min: 1, max: 365, step: 1 },
            { key: "cleanup_interval_hours", label: "🧹 Aufräum-Intervall (Std)", kind: "int", min: 1, max: 24, step: 1 },
        ];
    }
    async _pcInjectGlobalSettings(container) {
        const host = container.querySelector('#pc-global-settings');
        if (!host) return;
        let g = {};
        try { const r = await this._hass.callWS({ type: "rtsp_recorder/get_global_settings" }); g = (r && r.settings) || {}; } catch (e) {}
        this._pcGlobals = g;
        const head = "margin:18px 0 8px;font-size:0.95em;color:#bbb;font-weight:500;";
        const rows = this._pcGlobalSettingsFields().map(f => this._pcRow(f, g[f.key], "s")).join("");
        const sidebarOn = g.sidebar_panel_enabled !== false;
        // --- Rate-Limiter (HIGH-001): isolierter Block + eigener Save; teilt NICHT den Storage-Save ---
        const rlMode = g.rate_limit_mode || 'off';
        const rlRpw = (g.rate_limit_requests_per_window != null) ? g.rate_limit_requests_per_window : 120;
        const rlBurst = (g.rate_limit_burst_size != null) ? g.rate_limit_burst_size : 60;
        let rlStats = 'Status nicht verfügbar';
        try {
            const sr = await this._hass.callWS({ type: 'rtsp_recorder/get_rate_limit_stats' });
            const st = (sr && sr.stats) || {};
            rlStats = `mode=${st.mode} · would-block gesamt=${st.total_would_block_seen ?? '?'} · Requests gesehen=${st.total_requests_seen ?? '?'} · aktive Clients=${st.active_clients ?? '?'}`;
        } catch (e) {}
        const rlOpt = (v) => `<option value="${v}"${rlMode === v ? ' selected' : ''}>${v}</option>`;
        host.innerHTML = `
            <h4 style="${head}">📁 Speicher & Aufbewahrung</h4>${rows}
            <button id="pc-glob-save" style="margin-top:8px;padding:8px 16px;background:var(--primary-color,#03a9f4);color:#fff;border:none;border-radius:6px;cursor:pointer;">Speicher-Einstellungen speichern</button>
            <h4 style="${head}">🧩 Sidebar-Panel</h4>
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div><span style="font-weight:500;">Sidebar-Eintrag „RTSP Recorder" anzeigen</span><div style="font-size:0.8em;color:#888;margin-top:4px;">Zeigt diese Card auch als eigenen Sidebar-Eintrag. Wirkt nach Reload/Neustart.</div></div>
                <input type="checkbox" id="pc-sidebar-toggle" ${sidebarOn ? 'checked' : ''} style="transform:scale(1.3);cursor:pointer;">
            </div>
            <h4 style="${head}">🛡️ Rate-Limiter (DoS-Schutz, HIGH-001)</h4>
            <div style="font-size:0.8em;color:#888;margin-bottom:6px;"><b>off</b>=aus · <b>monitor</b>=nur messen (Shadow) · <b>enforce</b>=aktiv drosseln. Jede Änderung löst einen Integrations-Reload aus.</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
                <span style="font-weight:500;">Modus</span>
                <select id="pc-rl-mode" style="padding:6px;border-radius:6px;background:#2a2a2a;color:#fff;border:1px solid #444;cursor:pointer;">${rlOpt('off')}${rlOpt('monitor')}${rlOpt('enforce')}</select>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
                <span style="font-weight:500;">Requests / 60s</span>
                <input type="number" id="pc-rl-rpw" min="1" max="100000" step="1" value="${rlRpw}" style="width:110px;padding:6px;border-radius:6px;background:#2a2a2a;color:#fff;border:1px solid #444;">
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
                <span style="font-weight:500;">Burst</span>
                <input type="number" id="pc-rl-burst" min="0" max="100000" step="1" value="${rlBurst}" style="width:110px;padding:6px;border-radius:6px;background:#2a2a2a;color:#fff;border:1px solid #444;">
            </div>
            <button id="pc-rl-save" style="margin-top:6px;padding:8px 16px;background:var(--primary-color,#03a9f4);color:#fff;border:none;border-radius:6px;cursor:pointer;">Rate-Limit-Limits speichern</button>
            <div id="pc-rl-stats" style="font-size:0.78em;color:#9aa;margin-top:8px;">${this._pcEsc(rlStats)}</div>`;
        host.querySelector('#pc-glob-save').addEventListener('click', async () => {
            if (this._pcBusy) return; this._pcBusy = true;
            const settings = {};
            this._pcGlobalSettingsFields().forEach(f => { const v = this._pcRead(host, f, "s"); if (v !== undefined) settings[f.key] = v; });
            try { const r = await this._hass.callWS({ type: "rtsp_recorder/set_global_settings", settings }); if (!r || !r.success) throw new Error((r && r.message) || "Fehler"); this.showToast('Speicher-Einstellungen gespeichert', 'success'); }
            catch (e) { this.showToast('⚠️ ' + e.message, 'error'); } finally { this._pcBusy = false; }
        });
        host.querySelector('#pc-sidebar-toggle').addEventListener('change', async (e) => {
            const on = e.target.checked;
            try { const r = await this._hass.callWS({ type: "rtsp_recorder/set_global_settings", settings: { sidebar_panel_enabled: on } }); if (!r || !r.success) throw new Error((r && r.message) || "Fehler"); this.showToast(on ? 'Sidebar-Panel aktiviert (nach Reload sichtbar)' : 'Sidebar-Panel deaktiviert (nach Reload weg)', 'success'); }
            catch (err) { this.showToast('⚠️ ' + err.message, 'error'); }
        });
        // --- Rate-Limiter-Handler (isoliert: eigene settings-Objekte, nur rate_limit_*-Keys) ---
        const rlSet = async (settings, okMsg) => {
            if (this._pcBusy) return; this._pcBusy = true;
            try { const r = await this._hass.callWS({ type: "rtsp_recorder/set_global_settings", settings }); if (!r || !r.success) throw new Error((r && r.message) || "Fehler"); this.showToast(okMsg, 'success'); }
            catch (e) { this.showToast('⚠️ ' + e.message, 'error'); } finally { this._pcBusy = false; }
        };
        const rlModeEl = host.querySelector('#pc-rl-mode');
        if (rlModeEl) rlModeEl.addEventListener('change', (e) => rlSet({ rate_limit_mode: e.target.value }, 'Rate-Limit-Modus: ' + e.target.value + ' (nach Reload aktiv)'));
        const rlSaveEl = host.querySelector('#pc-rl-save');
        if (rlSaveEl) rlSaveEl.addEventListener('click', () => {
            const rpw = parseInt(host.querySelector('#pc-rl-rpw').value, 10);
            const burst = parseInt(host.querySelector('#pc-rl-burst').value, 10);
            if (!Number.isFinite(rpw) || rpw < 1 || !Number.isFinite(burst) || burst < 0) { this.showToast('⚠️ Ungültige Limit-Werte', 'error'); return; }
            rlSet({ rate_limit_requests_per_window: rpw, rate_limit_burst_size: burst }, 'Rate-Limit-Limits gespeichert (nach Reload aktiv)');
        });
    }
}

// REGISTER STANDARD CARD (only if not already registered)
if (!customElements.get('rtsp-recorder-card')) {
    customElements.define('rtsp-recorder-card', RtspRecorderCard);
}

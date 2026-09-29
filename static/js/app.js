// ==================== CONFIG ====================
const API_BASE = '/api';
let currentUser = null;
let accessToken = null;
let wsConnections = {};
let realtimeInterval = null;
let isDemoMode = true;
let lastRealDataTimestamp = 0;

const ESP32_CONFIG = {
    demoFallback: true,
    fallbackTimeout: 30000
};

// ==================== AUTH ====================
async function login(username, password) {
    const response = await fetch(`${API_BASE}/users/login/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erreur de connexion');
    }
    const data = await response.json();
    accessToken = data.access;
    currentUser = data.user;
    localStorage.setItem('access_token', data.access);
    localStorage.setItem('refresh_token', data.refresh);
    return data;
}

function logout() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    currentUser = null;
    accessToken = null;
    if (realtimeInterval) clearInterval(realtimeInterval);
    Object.values(wsConnections).forEach(ws => ws.close());
    wsConnections = {};
    location.reload();
}

async function apiRequest(endpoint, options = {}) {
    const token = accessToken || localStorage.getItem('access_token');
    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {})
        }
    });
    if (response.status === 401) {
        localStorage.removeItem('access_token');
        location.reload();
        return;
    }
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Erreur serveur');
    }
    return response.json();
}

function connectWebSocket(path, onMessage) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${path}`;
    
    // Vérifier si on est en mode fichier (file://) ou si le host est vide
    if (window.location.protocol === 'file:' || !window.location.host) {
        console.log('WS ignoré: pas de serveur web détecté');
        return null;
    }
    
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log(`WS connecté: ${path}`);
        // Mettre à jour le statut dans les paramètres si visible
        renderSettings();
    };
    
    ws.onmessage = (e) => {
        try {
            onMessage(JSON.parse(e.data));
        } catch (err) {
            console.warn('WS message invalide:', e.data);
        }
    };
    
    ws.onerror = (err) => {
        console.warn(`WS erreur (${path}):`, err.type);
    };
    
    ws.onclose = (event) => {
        // Ne pas reconnexion automatique si erreur de handshake (code 1006 avec code HTTP 200)
        if (event.code === 1006) {
            console.log(`WS fermé (${path}) - pas de reconnexion auto (serveur non prêt)`);
            return;
        }
        console.log(`WS fermé (${path}), reconnexion dans 5s...`);
        setTimeout(() => connectWebSocket(path, onMessage), 5000);
    };
    
    wsConnections[path] = ws;
    return ws;
}

function handleDashboardMessage(data) {
    if (data.type === 'alarm_update') {
        showNotification('Nouvelle alarme', data.data?.title || '', 'warning');
    }
}

// ==================== DONNÉES ÉQUIPEMENTS ====================
let EQUIPMENTS_DATA = {
    remplisseuse: {
        id: 1, name: 'Remplisseuse', station: 'Station #1',
        status: 'en_marche', esp32_ip: '192.168.1.101', esp32_port: 8080,
        last_maintenance: '15/04/2026',
        sensors: {
            temperature: { value: 45.2, unit: '°C', threshold: 60, critical: 75, status: 'normal', pin: 'GPIO4' },
            pressure:    { value: 4.2,  unit: ' bar', threshold: 5.5, critical: 7.0, status: 'normal', pin: 'GPIO34' },
            vibration:   { value: 2.1,  unit: ' mm/s', threshold: 4.5, critical: 6.0, status: 'normal', pin: 'GPIO18' },
            current:     { value: 10.5, unit: ' A', threshold: 12.0, critical: 15.0, status: 'normal', pin: 'GPIO35' }
        }
    },
    compresseur: {
        id: 2, name: "Compresseur d'air", station: 'Station #2',
        status: 'alerte', esp32_ip: '192.168.1.102', esp32_port: 8080,
        last_maintenance: '10/04/2026',
        sensors: {
            temperature: { value: 78.5, unit: '°C', threshold: 70, critical: 85, status: 'warning', pin: 'GPIO5' },
            pressure:    { value: 6.8,  unit: ' bar', threshold: 7.5, critical: 9.0, status: 'normal', pin: 'GPIO32' },
            current:     { value: 12.4, unit: ' A', threshold: 15.0, critical: 18.0, status: 'normal', pin: 'GPIO33' }
        }
    },
    convoyeur: {
        id: 3, name: 'Convoyeur', station: 'Station #3',
        status: 'en_marche', esp32_ip: '192.168.1.103', esp32_port: 8080,
        last_maintenance: '20/04/2026',
        sensors: {
            speed:     { value: 1.2, unit: ' m/s', threshold: 1.5, critical: 1.8, status: 'normal', pin: 'GPIO21' },
            vibration: { value: 1.8, unit: ' mm/s', threshold: 3.0, critical: 4.5, status: 'normal', pin: 'GPIO22' },
            current:   { value: 8.2, unit: ' A', threshold: 10.0, critical: 12.0, status: 'normal', pin: 'GPIO25' }
        }
    }
};

// ==================== DONNÉES DYNAMIQUES ====================
let ALARMS_HISTORY = [];
let WORK_ORDERS = [];
let USERS_DATA = [];
let REPORTS_DATA = [];
let MAINTENANCE_PLAN = [];
let currentAlarmFilter = 'all';
let currentWOFilter = 'all';
let supervisionCharts = {};

// ==================== PLANIFICATION - VARIABLES ====================
let currentPlanningMonth = new Date().getMonth();
let currentPlanningYear = new Date().getFullYear();
let selectedPlanningDate = null;

const MONTH_NAMES = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 
                     'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

// ==================== RAPPORTS - VARIABLES ====================
let reportFilter = { equipment: 'all', type: 'all', status: 'all', search: '' };
let reportSort = { field: 'date', direction: 'desc' };

// ==================== INITIALISATION DES DONNÉES ====================
function initDemoData() {
    // Alarmes initiales avec historique complet
    ALARMS_HISTORY = [
        {
            id: 1, title: 'SurTempérature Compresseur',
            description: 'Température du compresseur dépasse le seuil critique (78.5°C >= 70°C)',
            severity: 'critical', equipment: "Compresseur d'air", station: 'Station #2',
            sensor: 'DS18B20', time: '14:23:15', date: '19/05/2026', status: 'active'
        },
        {
            id: 2, title: 'Surcharge Courant Remplisseuse',
            description: 'Consommation électrique anormale détectée (15.2A / 12A max)',
            severity: 'critical', equipment: 'Remplisseuse', station: 'Station #1',
            sensor: 'ACS712', time: '14:15:42', date: '19/05/2026', status: 'active'
        },
        {
            id: 3, title: 'Vibration Élevée Convoyeur',
            description: 'Niveau de vibration supérieur à la moyenne (2.5 mm/s)',
            severity: 'warning', equipment: 'Convoyeur', station: 'Station #3',
            sensor: 'SW-420', time: '13:45:20', date: '19/05/2026', status: 'active'
        },
        {
            id: 4, title: 'Pression Faible Remplisseuse',
            description: 'Pression descendue en dessous du seuil (3.8 bar < 4.0 bar)',
            severity: 'warning', equipment: 'Remplisseuse', station: 'Station #1',
            sensor: 'MPX5700', time: '12:30:10', date: '19/05/2026', status: 'acknowledged'
        },
        {
            id: 5, title: 'Maintenance Périodique',
            description: 'Maintenance préventive planifiée pour le compresseur',
            severity: 'info', equipment: "Compresseur d'air", station: 'Station #2',
            sensor: 'Système', time: '08:00:00', date: '18/05/2026', status: 'resolved'
        }
    ];

    // Ordres de travail complets
    WORK_ORDERS = [
        {
            id: 24, number: 'OT-24', title: 'Maintenance Préventive Remplisseuse',
            type: 'Préventive', status: 'in_progress', priority: 'normal',
            assigned: 'Agent Maintenance #1', deadline: '30/05/2026',
            description: 'Lubrification et contrôle des joints', equipment: 'Remplisseuse',
            created: '15/05/2026', duration: '2h30'
        },
        {
            id: 25, number: 'OT-25', title: 'Correction SurTempérature Compresseur',
            type: 'Corrective', status: 'planned', priority: 'urgent',
            assigned: 'Non assigné', deadline: '28/05/2026',
            description: 'Vérification système refroidissement', equipment: "Compresseur d'air",
            created: '19/05/2026', duration: '4h00'
        },
        {
            id: 26, number: 'OT-26', title: 'Inspection Vibration Convoyeur',
            type: 'Prédictive', status: 'planned', priority: 'normal',
            assigned: 'Agent Maintenance #2', deadline: '29/05/2026',
            description: 'Analyse spectre vibration et ajustement', equipment: 'Convoyeur',
            created: '18/05/2026', duration: '1h30'
        },
        {
            id: 27, number: 'OT-27', title: 'Remplacement Filtre Compresseur',
            type: 'Corrective', status: 'completed', priority: 'high',
            assigned: 'Agent Maintenance #1', deadline: '15/05/2026',
            description: 'Remplacement du filtre à air et test', equipment: "Compresseur d'air",
            created: '10/05/2026', duration: '1h00'
        }
    ];

    // Utilisateurs
    USERS_DATA = [
        { id: 1, username: 'superviseur', first_name: 'Ulrich', last_name: 'Koundi', email: 'ulrichkoundi05@gmail.com', role: 'superviseur', department: 'Production', last_login: '04/07/2026 11:00', status: 'active' },
        { id: 2, username: 'maintenance', first_name: 'Ernest', last_name: 'Mbatowa', email: 'jeanernest657@gmail.com', role: 'superviseur', department: 'Production', last_login: '03/07/2026 13:30', status: 'active' },
        { id: 3, username: 'operateur', first_name: 'Jacques Bertrand', last_name: 'Mang', email: 'jbmang@outlook.com', role: 'operateur', department: 'Opérations', last_login: '19/06/2026 12:15', status: 'inactive' },
        { id: 4, username: 'maintenance2', first_name: 'Jean', last_name: 'Bahebeck', email: 'jeanbahebeck64@icloud.com', role: 'maintenance', department: 'Maintenance', last_login: '18/06/2026 17:00', status: 'inactive' }
    ];

    // Rapports
    REPORTS_DATA = [
        { id: 1, number: 'RPT-001', date: '15/05/2026', equipment: "Compresseur d'air", type: 'Corrective', technician: 'Koffi Amadou', duration: '2h15', status: 'validé', description: 'Remplacement filtre à air' },
        { id: 2, number: 'RPT-002', date: '12/05/2026', equipment: 'Remplisseuse', type: 'Préventive', technician: 'Bruno Bidjang', duration: '3h00', status: 'validé', description: 'Lubrification complète' },
        { id: 3, number: 'RPT-003', date: '10/05/2026', equipment: 'Convoyeur', type: 'Prédictive', technician: 'Marie Curry', duration: '1h30', status: 'en_attente', description: 'Analyse vibration' },
        { id: 4, number: 'RPT-004', date: '08/05/2026', equipment: "Compresseur d'air", type: 'Corrective', technician: 'Koffi Amadou', duration: '4h00', status: 'validé', description: 'Réparation fuite air' },
        { id: 5, number: 'RPT-005', date: '05/05/2026', equipment: 'Remplisseuse', type: 'Préventive', technician: 'J.P Remy Ngono', duration: '2h00', status: 'validé', description: 'Contrôle joints' }
    ];

    // Plan de maintenance
    MAINTENANCE_PLAN = [
        { id: 1, equipment: 'Remplisseuse', type: 'Préventive', frequency: 'Mensuelle', next_date: '25/05/2026', last_date: '25/04/2026', duration: '2h', technician: 'Agent Maintenance #1' },
        { id: 2, equipment: "Compresseur d'air", type: 'Préventive', frequency: 'Hebdomadaire', next_date: '22/05/2026', last_date: '15/05/2026', duration: '1h', technician: 'Agent Maintenance #2' },
        { id: 3, equipment: 'Convoyeur', type: 'Prédictive', frequency: 'Trimestrielle', next_date: '15/06/2026', last_date: '15/03/2026', duration: '3h', technician: 'Agent Maintenance #1' },
        { id: 4, equipment: 'Remplisseuse', type: 'Corrective', frequency: 'Sur demande', next_date: '-', last_date: '10/05/2026', duration: 'Variable', technician: 'Non assigné' }
    ];
}

// ==================== GÉNÉRATION ALARME ALÉATOIRE ====================
function generateRandomAlarm() {
    const equipKeys = Object.keys(EQUIPMENTS_DATA);
    const randomEquip = equipKeys[Math.floor(Math.random() * equipKeys.length)];
    const equip = EQUIPMENTS_DATA[randomEquip];
    const sensorKeys = Object.keys(equip.sensors);
    const randomSensor = sensorKeys[Math.floor(Math.random() * sensorKeys.length)];
    const sensor = equip.sensors[randomSensor];

    if (sensor.status !== 'normal') {
        const now = new Date();
        const newAlarm = {
            id: Date.now(),
            title: `${sensor.status === 'critical' ? 'Critique' : 'Attention'} ${sensorKeyToLabel(randomSensor)} ${equip.name}`,
            description: `${sensorKeyToLabel(randomSensor)} du ${equip.name} : ${sensor.value.toFixed(1)}${sensor.unit} (seuil: ${sensor.threshold}${sensor.unit})`,
            severity: sensor.status,
            equipment: equip.name,
            station: equip.station,
            sensor: sensor.pin,
            time: now.toLocaleTimeString('fr-FR'),
            date: now.toLocaleDateString('fr-FR'),
            status: 'active'
        };
        ALARMS_HISTORY.unshift(newAlarm);
        showNotification('Nouvelle alarme', newAlarm.title, sensor.status === 'critical' ? 'error' : 'warning');
    }
}

function sensorKeyToLabel(key) {
    const labels = { temperature: 'Température', pressure: 'Pression', vibration: 'Vibration', current: 'Courant', speed: 'Vitesse', level: 'Niveau' };
    return labels[key] || key;
}

// ==================== MISE À JOUR COMPLÈTE DASHBOARD ====================
function updateRealtimeValues() {
    // Dashboard - Cartes équipements avec IDs spécifiques
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const equip = EQUIPMENTS_DATA[equipKey];

        // Badge statut
        const statusEl = document.getElementById(`status-${equipKey}`);
        if (statusEl) {
            const statusConfig = {
                en_marche: { text: 'En marche', bg: 'bg-green-100', textCol: 'text-green-700' },
                alerte: { text: 'Attention', bg: 'bg-amber-100', textCol: 'text-amber-700' },
                arret: { text: 'Arrêt', bg: 'bg-red-100', textCol: 'text-red-700' },
                maintenance: { text: 'Maintenance', bg: 'bg-blue-100', textCol: 'text-blue-700' }
            };
            const cfg = statusConfig[equip.status] || statusConfig.en_marche;
            statusEl.className = `px-3 py-1 ${cfg.bg} ${cfg.textCol} rounded-full text-xs font-semibold`;
            statusEl.textContent = cfg.text;
        }

        // Valeurs et barres de progression
        Object.keys(equip.sensors).forEach(sensorKey => {
            const sensor = equip.sensors[sensorKey];
            const valEl = document.getElementById(`val-${equipKey}-${sensorKey}`);
            const barEl = document.getElementById(`bar-${equipKey}-${sensorKey}`);

            if (valEl) {
                valEl.textContent = `${sensor.value.toFixed(1)}${sensor.unit}`;
                valEl.className = `font-mono font-semibold realtime-value ${
                    sensor.status === 'critical' ? 'text-red-600' :
                    sensor.status === 'warning' ? 'text-amber-600' : 'text-slate-700'
                }`;
            }

            if (barEl) {
                const pct = Math.min(100, (sensor.value / sensor.critical) * 100);
                barEl.style.width = `${pct}%`;
                barEl.className = `progress-bar h-2 rounded-full transition-all duration-500 ${
                    sensor.status === 'critical' ? 'bg-red-500' :
                    sensor.status === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                }`;
            }
        });

        // Dernière maintenance
        const maintEl = document.querySelector(`[data-equip="${equipKey}"] .text-xs.text-slate-400`);
        if (maintEl && equip.last_maintenance) {
            maintEl.textContent = `Dernière maintenance: ${equip.last_maintenance}`;
        }
    });

    updateKPIs();
    updateSynoptic();
    updateSupervisionGauges();
}

// ==================== SUPERVISION - GAUGES TEMPS RÉEL ====================
function initSupervisionCharts() {
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const container = document.getElementById(`supervision-${equipKey}`);
        if (!container) return;

        container.innerHTML = '';
        const equip = EQUIPMENTS_DATA[equipKey];

        Object.entries(equip.sensors).forEach(([sensorKey, sensor]) => {
            const chartId = `gauge-${equipKey}-${sensorKey}`;
            const wrapper = document.createElement('div');
            wrapper.className = 'bg-slate-50 rounded-lg p-4';
            wrapper.innerHTML = `
                <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-medium text-slate-600 capitalize">${sensorKeyToLabel(sensorKey)}</span>
                    <span id="gauge-badge-${equipKey}-${sensorKey}" class="text-xs px-2 py-0.5 rounded ${sensor.status === 'critical' ? 'bg-red-100 text-red-700' : sensor.status === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}">${sensor.status === 'normal' ? 'Normal' : sensor.status === 'warning' ? 'Attention' : 'Critique'}</span>
                </div>
                <div style="position: relative; height: 120px;">
                    <canvas id="${chartId}"></canvas>
                </div>
                <div class="text-center mt-2">
                    <span class="text-2xl font-bold text-slate-800" id="gauge-val-${equipKey}-${sensorKey}">${sensor.value.toFixed(1)}</span>
                    <span class="text-sm text-slate-500">${sensor.unit}</span>
                </div>
                <div class="flex justify-between text-xs text-slate-400 mt-1">
                    <span>0</span>
                    <span>Seuil: ${sensor.threshold}</span>
                    <span>Max: ${sensor.critical}</span>
                </div>
            `;
            container.appendChild(wrapper);

            const ctx = document.getElementById(chartId);
            if (ctx) {
                if (supervisionCharts[chartId]) supervisionCharts[chartId].destroy();

                const pct = Math.min(100, (sensor.value / sensor.critical) * 100);
                const color = sensor.status === 'critical' ? '#ef4444' : sensor.status === 'warning' ? '#f59e0b' : '#3b82f6';

                supervisionCharts[chartId] = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Valeur', 'Reste'],
                        datasets: [{
                            data: [pct, 100 - pct],
                            backgroundColor: [color, 'rgba(0,0,0,0.05)'],
                            borderWidth: 0,
                            cutout: '75%'
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        rotation: -90,
                        circumference: 180,
                        plugins: {
                            legend: { display: false },
                            tooltip: { enabled: false }
                        },
                        animation: { animateRotate: true, animateScale: false }
                    }
                });
            }
        });
    });
}

function updateSupervisionGauges() {
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const equip = EQUIPMENTS_DATA[equipKey];
        Object.entries(equip.sensors).forEach(([sensorKey, sensor]) => {
            const chartId = `gauge-${equipKey}-${sensorKey}`;
            const valEl = document.getElementById(`gauge-val-${equipKey}-${sensorKey}`);
            const badgeEl = document.getElementById(`gauge-badge-${equipKey}-${sensorKey}`);

            if (valEl) {
                valEl.textContent = sensor.value.toFixed(1);
                valEl.className = `text-2xl font-bold ${sensor.status === 'critical' ? 'text-red-600' : sensor.status === 'warning' ? 'text-amber-600' : 'text-slate-800'}`;
            }

            if (badgeEl) {
                badgeEl.className = `text-xs px-2 py-0.5 rounded ${sensor.status === 'critical' ? 'bg-red-100 text-red-700' : sensor.status === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`;
                badgeEl.textContent = sensor.status === 'normal' ? 'Normal' : sensor.status === 'warning' ? 'Attention' : 'Critique';
            }

            if (supervisionCharts[chartId]) {
                const pct = Math.min(100, (sensor.value / sensor.critical) * 100);
                const color = sensor.status === 'critical' ? '#ef4444' : sensor.status === 'warning' ? '#f59e0b' : '#3b82f6';
                supervisionCharts[chartId].data.datasets[0].data = [pct, 100 - pct];
                supervisionCharts[chartId].data.datasets[0].backgroundColor = [color, 'rgba(0,0,0,0.05)'];
                supervisionCharts[chartId].update('none');
            }
        });
    });
}

// ==================== SYNOPTIQUE DYNAMIQUE ====================
function updateSynoptic() {
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const equip = EQUIPMENTS_DATA[equipKey];
        const statusEl = document.getElementById(`syno-${equipKey}-status`);
        const equipEl = document.querySelector(`.synoptic-equip[onclick*="${equipKey}"]`);

        if (statusEl) {
            const hasCritical = Object.values(equip.sensors).some(s => s.status === 'critical');
            const hasWarning = Object.values(equip.sensors).some(s => s.status === 'warning');
            statusEl.textContent = hasCritical ? 'Critique' : hasWarning ? 'Attention' : 'Normal';
        }

        if (equipEl) {
            equipEl.classList.remove('active', 'warning', 'critical');
            const hasCritical = Object.values(equip.sensors).some(s => s.status === 'critical');
            const hasWarning = Object.values(equip.sensors).some(s => s.status === 'warning');
            if (hasCritical) equipEl.classList.add('critical');
            else if (hasWarning) equipEl.classList.add('warning');
            else equipEl.classList.add('active');
        }
    });
}

// ==================== KPIs DYNAMIQUES ====================
function updateKPIs() {
    let criticalCount = 0;
    let warningCount = 0;
    let activeEquipments = 0;

    Object.values(EQUIPMENTS_DATA).forEach(equip => {
        if (equip.status === 'en_marche') activeEquipments++;
        Object.values(equip.sensors).forEach(sensor => {
            if (sensor.status === 'critical') criticalCount++;
            else if (sensor.status === 'warning') warningCount++;
        });
    });

    // Badge sidebar
    const alarmBadge = document.getElementById('alarmBadge');
    if (alarmBadge) alarmBadge.textContent = criticalCount + warningCount;

    // Header alarm badge
    const headerAlarmBadge = document.getElementById('headerAlarmBadge');
    if (headerAlarmBadge) {
        headerAlarmBadge.classList.toggle('hidden', criticalCount + warningCount === 0);
    }

    // KPI - État général
    const kpiStatus = document.getElementById('kpiStatus');
    const kpiStatusBadge = document.getElementById('kpiStatusBadge');
    const kpiStatusDetail = document.getElementById('kpiStatusDetail');

    if (kpiStatus) {
        if (criticalCount > 0) {
            kpiStatus.textContent = 'Dégradé';
            kpiStatus.className = 'text-2xl font-bold text-red-600 mt-1';
            if (kpiStatusBadge) { kpiStatusBadge.textContent = 'Critique'; kpiStatusBadge.className = 'text-xs font-medium text-red-600 bg-red-50 px-2 py-1 rounded'; }
        } else if (warningCount > 0) {
            kpiStatus.textContent = 'Attention';
            kpiStatus.className = 'text-2xl font-bold text-amber-600 mt-1';
            if (kpiStatusBadge) { kpiStatusBadge.textContent = 'Alerte'; kpiStatusBadge.className = 'text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded'; }
        } else {
            kpiStatus.textContent = 'Opérationnel';
            kpiStatus.className = 'text-2xl font-bold text-green-600 mt-1';
            if (kpiStatusBadge) { kpiStatusBadge.textContent = 'Normal'; kpiStatusBadge.className = 'text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded'; }
        }
    }
    if (kpiStatusDetail) {
        kpiStatusDetail.textContent = `${activeEquipments}/3 équipements actifs`;
    }

    // KPI - Alarmes
    const kpiCriticalAlarms = document.getElementById('kpiCriticalAlarms');
    const kpiAlarmDetail = document.getElementById('kpiAlarmDetail');
    const kpiAlarmBadge = document.getElementById('kpiAlarmBadge');

    if (kpiCriticalAlarms) kpiCriticalAlarms.textContent = `${criticalCount} Critique${criticalCount !== 1 ? 's' : ''}`;
    if (kpiAlarmDetail) kpiAlarmDetail.textContent = `${warningCount} Avertissement${warningCount !== 1 ? 's' : ''} en attente`;
    if (kpiAlarmBadge) {
        kpiAlarmBadge.textContent = `${criticalCount + warningCount} active${criticalCount + warningCount !== 1 ? 's' : ''}`;
        kpiAlarmBadge.className = `text-xs font-medium ${criticalCount > 0 ? 'text-red-600 bg-red-50' : 'text-amber-600 bg-amber-50'} px-2 py-1 rounded`;
    }

    // KPI - Interventions
    const activeWO = WORK_ORDERS.filter(wo => wo.status === 'in_progress').length;
    const plannedWO = WORK_ORDERS.filter(wo => wo.status === 'planned').length;
    const kpiWorkOrders = document.getElementById('kpiWorkOrders');
    const kpiWorkOrderDetail = document.getElementById('kpiWorkOrderDetail');

    if (kpiWorkOrders) kpiWorkOrders.textContent = `${activeWO} OT`;
    if (kpiWorkOrderDetail) kpiWorkOrderDetail.textContent = `${plannedWO} planifié${plannedWO !== 1 ? 's' : ''}, ${WORK_ORDERS.filter(wo => wo.status === 'completed').length} terminé${WORK_ORDERS.filter(wo => wo.status === 'completed').length !== 1 ? 's' : ''}`;

    // KPI - OEE (simulé)
    const oee = Math.round(85 + (Math.random() - 0.5) * 10);
    const kpiOEE = document.getElementById('kpiOEE');
    const kpiOEEBadge = document.getElementById('kpiOEEBadge');

    if (kpiOEE) {
        kpiOEE.textContent = `${oee}%`;
        kpiOEE.className = `text-2xl font-bold ${oee >= 85 ? 'text-green-600' : oee >= 70 ? 'text-amber-600' : 'text-red-600'} mt-1`;
    }
    if (kpiOEEBadge) {
        const trend = Math.round((Math.random() - 0.5) * 6);
        kpiOEEBadge.textContent = `${trend >= 0 ? '+' : ''}${trend}%`;
        kpiOEEBadge.className = `text-xs font-medium ${trend >= 0 ? 'text-green-600 bg-green-50' : 'text-red-600 bg-red-50'} px-2 py-1 rounded`;
    }
}

// ==================== SIMULATION AMÉLIORÉE ====================
function updateDemoValues() {
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const equip = EQUIPMENTS_DATA[equipKey];
        Object.keys(equip.sensors).forEach(sensorKey => {
            const sensor = equip.sensors[sensorKey];
            const variation = (Math.random() - 0.5) * (sensor.critical * 0.02);
            sensor.value = Math.max(0, sensor.value + variation);

            if (sensor.value >= sensor.critical) sensor.status = 'critical';
            else if (sensor.value >= sensor.threshold) sensor.status = 'warning';
            else sensor.status = 'normal';
        });

        const hasCritical = Object.values(equip.sensors).some(s => s.status === 'critical');
        const hasWarning = Object.values(equip.sensors).some(s => s.status === 'warning');
        if (hasCritical) equip.status = 'alerte';
        else if (hasWarning) equip.status = 'alerte';
        else equip.status = 'en_marche';
    });

    if (Math.random() < 0.05) generateRandomAlarm();
    addToHistory();
}

// ==================== BADGE MODE DÉMO ====================
function updateDemoBadge() {
    const badge = document.getElementById('demoBadge');
    if (badge) {
        badge.classList.toggle('hidden', !isDemoMode);
        badge.innerHTML = isDemoMode ? 
            '<i class="fas fa-microchip mr-1"></i> Mode Simulation ESP32' : 
            '<i class="fas fa-wifi mr-1"></i> Mode ESP32 Réel';
    }
}

function toggleDemoMode() {
    isDemoMode = !isDemoMode;
    lastRealDataTimestamp = isDemoMode ? 0 : Date.now();
    updateDemoBadge();
    showNotification('Mode', isDemoMode ? 'Mode simulation activé' : 'Mode données réelles activé', 'info');
}


// ==================== ALARMES - LISTE ACTIVE ====================
function renderAlarmsList() {
    const container = document.getElementById('alarmsList');
    if (!container) return;

    const activeAlarms = ALARMS_HISTORY.filter(a => a.status === 'active');

    if (activeAlarms.length === 0) {
        container.innerHTML = `
            <div class="bg-white rounded-xl p-8 shadow-sm border border-slate-200 text-center">
                <i class="fas fa-check-circle text-green-500 text-4xl mb-3"></i>
                <h3 class="text-lg font-semibold text-slate-700">Aucune alarme active</h3>
                <p class="text-sm text-slate-500 mt-1">Tous les équipements fonctionnent normalement</p>
            </div>
        `;
        return;
    }

    container.innerHTML = activeAlarms.map(alarm => `
        <div class="alarm-card ${alarm.severity} bg-white rounded-xl p-6 shadow-sm border border-slate-200" data-alarm-id="${alarm.id}">
            <div class="flex items-start justify-between">
                <div class="flex items-start gap-4">
                    <div class="w-12 h-12 bg-${alarm.severity === 'critical' ? 'red' : 'amber'}-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <i class="fas fa-${alarm.severity === 'critical' ? 'temperature-high' : 'exclamation-triangle'} text-${alarm.severity === 'critical' ? 'red' : 'amber'}-600 text-xl"></i>
                    </div>
                    <div>
                        <div class="flex items-center gap-2 mb-1">
                            <h3 class="font-bold text-slate-800">${alarm.title}</h3>
                            <span class="px-2 py-0.5 bg-${alarm.severity === 'critical' ? 'red' : 'amber'}-100 text-${alarm.severity === 'critical' ? 'red' : 'amber'}-700 rounded text-xs font-bold uppercase">${alarm.severity}</span>
                        </div>
                        <p class="text-sm text-slate-600 mb-2">${alarm.description}</p>
                        <div class="flex items-center gap-4 text-xs text-slate-500">
                            <span><i class="fas fa-clock mr-1"></i>${alarm.time}</span>
                            <span><i class="fas fa-map-marker-alt mr-1"></i>${alarm.station}</span>
                            <span><i class="fas fa-microchip mr-1"></i>Capteur: ${alarm.sensor}</span>
                        </div>
                    </div>
                </div>
                <div class="flex gap-2">
                    <button onclick="acknowledgeAlarm(${alarm.id})" class="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition-colors">
                        Acquitter
                    </button>
                    ${currentUser && currentUser.role !== 'operateur' ? `
                    <button onclick="triggerWorkOrder('${alarm.title}')" class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors create-ot-btn">
                        Créer OT
                    </button>
                    ` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

// ==================== ALARMES - HISTORIQUE ====================
function renderAlarmsHistory() {
    const tbody = document.getElementById('alarmsHistoryTable');
    if (!tbody) return;

    let filtered = ALARMS_HISTORY;
    if (currentAlarmFilter !== 'all') {
        filtered = ALARMS_HISTORY.filter(a => a.severity === currentAlarmFilter);
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">Aucun historique</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(alarm => {
        const severityColors = { critical: 'red', warning: 'amber', info: 'blue' };
        const statusColors = { active: 'red', acknowledged: 'amber', resolved: 'green' };
        const statusLabels = { active: 'Active', acknowledged: 'Acquittée', resolved: 'Résolue' };

        return `
            <tr class="hover:bg-slate-50">
                <td class="px-4 py-3 text-slate-700">${alarm.date} ${alarm.time}</td>
                <td class="px-4 py-3 font-medium text-slate-800">${alarm.equipment}</td>
                <td class="px-4 py-3 text-slate-600">${alarm.description}</td>
                <td class="px-4 py-3"><span class="px-2 py-0.5 bg-${severityColors[alarm.severity] || 'slate'}-100 text-${severityColors[alarm.severity] || 'slate'}-700 rounded text-xs font-semibold uppercase">${alarm.severity}</span></td>
                <td class="px-4 py-3"><span class="px-2 py-0.5 bg-${statusColors[alarm.status] || 'slate'}-100 text-${statusColors[alarm.status] || 'slate'}-700 rounded text-xs font-semibold">${statusLabels[alarm.status] || alarm.status}</span></td>
                <td class="px-4 py-3">
                    ${alarm.status === 'active' ? `<button onclick="acknowledgeAlarm(${alarm.id})" class="text-blue-600 hover:text-blue-800 text-sm">Acquitter</button>` : '<span class="text-slate-400 text-sm">-</span>'}
                </td>
            </tr>
        `;
    }).join('');
}

function filterAlarms(filter) {
    currentAlarmFilter = filter;
    renderAlarmsHistory();
    updateAlarmCounts();
}

function updateAlarmCounts() {
    const critical = ALARMS_HISTORY.filter(a => a.severity === 'critical' && a.status === 'active').length;
    const warning = ALARMS_HISTORY.filter(a => a.severity === 'warning' && a.status === 'active').length;

    const countCritical = document.getElementById('count-critical');
    const countWarning = document.getElementById('count-warning');

    if (countCritical) countCritical.textContent = critical;
    if (countWarning) countWarning.textContent = warning;
}

function acknowledgeAlarm(alarmId) {
    const alarm = ALARMS_HISTORY.find(a => a.id === alarmId);
    if (alarm) {
        alarm.status = 'acknowledged';
        showNotification('Alarme acquittée', `Alarme #${alarmId} acquittée avec succès.`, 'success');
    }
    renderAlarmsList();
    renderAlarmsHistory();
    updateAlarmCounts();
    updateKPIs();
}

// ==================== ALARMES - CAPTEURS DYNAMIQUES ====================
function updateAlarmSensors() {
    const equipSelect = document.getElementById('alarmEquipment');
    const sensorSelect = document.getElementById('alarmSensor');
    const sensorInfo = document.getElementById('alarmSensorInfo');
    
    if (!equipSelect || !sensorSelect) return;
    
    const equipKey = equipSelect.value;
    const equip = EQUIPMENTS_DATA[equipKey];
    
    if (!equip) {
        sensorSelect.innerHTML = '<option value="">-- Sélectionnez un équipement --</option>';
        if (sensorInfo) sensorInfo.textContent = 'Équipement invalide';
        return;
    }
    
    // Construire les options selon les capteurs réels de l'équipement
    const sensors = equip.sensors;
    const sensorLabels = {
        temperature: 'Température',
        pressure: 'Pression',
        vibration: 'Vibration',
        current: 'Courant',
        speed: 'Vitesse',
        level: 'Niveau'
    };
    
    sensorSelect.innerHTML = Object.keys(sensors).map(key => {
        const sensor = sensors[key];
        return `<option value="${key}">${sensorLabels[key] || key} (Pin: ${sensor.pin})</option>`;
    }).join('');
    
    if (sensorInfo) {
        sensorInfo.textContent = `${Object.keys(sensors).length} capteur(s) disponible(s) sur ${equip.name}`;
        sensorInfo.className = 'text-xs text-green-600 mt-1';
    }
}

function submitAlarm(e) {
    e.preventDefault();

    

    const equipment = document.getElementById('alarmEquipment');
    const sensor = document.getElementById('alarmSensor');
    const severity = document.getElementById('alarmSeverity');
    const value = document.getElementById('alarmValue');
    const title = document.getElementById('alarmTitle');
    const description = document.getElementById('alarmDescription');
    const createWO = document.getElementById('alarmCreateWO');

    // Validation: vérifier que le capteur existe sur l'équipement
    const equipData = EQUIPMENTS_DATA[equipment.value];
    if (equipData && !equipData.sensors[sensor.value]) {
        showNotification('Erreur', `Le capteur "${sensor.value}" n'existe pas sur ${equipData.name}. Capteurs disponibles: ${Object.keys(equipData.sensors).join(', ')}`, 'error');
        return;
    }

    if (!title.value.trim()) {
        showNotification('Erreur', 'Le titre est obligatoire', 'error');
        title.focus();
        return;
    }

    const now = new Date();
    const sensorData = equipData ? equipData.sensors[sensor.value] : null;

    const newAlarm = {
        id: Date.now(),
        title: title.value.trim(),
        description: description.value.trim() || `Alarme ${severity.value} sur ${equipData ? equipData.name : equipment.value}`,
        severity: severity.value,
        equipment: equipData ? equipData.name : equipment.value,
        station: equipData ? equipData.station : 'Station inconnue',
        sensor: sensorData ? sensorData.pin : sensor.value,
        time: now.toLocaleTimeString('fr-FR'),
        date: now.toLocaleDateString('fr-FR'),
        status: 'active',
        value: parseFloat(value.value) || 0,
        sensorType: sensor.value
    };

    ALARMS_HISTORY.unshift(newAlarm);
    showNotification('Alarme créée', `${newAlarm.title} - Niveau: ${severity.value}`, severity.value === 'critical' ? 'error' : 'warning');

    // Mettre à jour le capteur correspondant si l'équipement existe
    if (equipData && sensorData && value.value) {
        sensorData.value = parseFloat(value.value);
        if (severity.value === 'critical') {
            sensorData.status = 'critical';
            equipData.status = 'alerte';
        } else if (severity.value === 'warning') {
            sensorData.status = 'warning';
            equipData.status = 'alerte';
        }
        updateRealtimeValues();
        updateSynoptic();
    }

    // Créer un OT automatiquement si demandé
    if (createWO && createWO.checked) {
        const equipMap = { 'remplisseuse': '1', 'compresseur': '2', 'convoyeur': '3' };
        const newWO = {
            id: Date.now() + 1,
            number: `OT-${WORK_ORDERS.length + 24}`,
            title: `Intervention: ${newAlarm.title}`,
            type: severity.value === 'critical' ? 'Corrective' : 'Préventive',
            status: 'planned',
            priority: severity.value === 'critical' ? 'urgent' : 'high',
            assigned: 'Non assigné',
            deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toLocaleDateString('fr-FR'),
            description: `OT auto-généré depuis l'alarme: ${newAlarm.description}`,
            equipment: equipData ? equipData.name : equipment.value,
            created: now.toLocaleDateString('fr-FR'),
            duration: severity.value === 'critical' ? '4h00' : '2h00'
        };
        WORK_ORDERS.unshift(newWO);
        showNotification('OT créé', `${newWO.number} créé automatiquement`, 'success');
    }

       closeModal('newAlarmModal');
    document.getElementById('alarmForm').reset();
    
    // Réinitialiser les capteurs après reset
    setTimeout(() => updateAlarmSensors(), 50);
    
    renderAlarmsList();
    renderAlarmsHistory();
    updateAlarmCounts();
    updateKPIs();
    renderWorkOrdersList();
    updateWOCounts();
}

// ==================== ORDRES DE TRAVAIL - LISTE ====================
function renderWorkOrdersList() {
    const container = document.getElementById('workOrdersList');
    if (!container) return;

    let filtered = WORK_ORDERS;
    if (currentWOFilter !== 'all') {
        filtered = WORK_ORDERS.filter(wo => wo.status === currentWOFilter);
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="col-span-2 bg-white rounded-xl p-8 shadow-sm border border-slate-200 text-center">
                <i class="fas fa-clipboard-check text-slate-300 text-4xl mb-3"></i>
                <h3 class="text-lg font-semibold text-slate-700">Aucun ordre de travail</h3>
                <p class="text-sm text-slate-500 mt-1">Créez un nouvel OT pour commencer</p>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(wo => {
        const priorityColor = wo.priority === 'urgent' ? 'red' : wo.priority === 'high' ? 'amber' : 'blue';
        const statusColor = wo.status === 'completed' ? 'green' : wo.status === 'in_progress' ? 'amber' : 'blue';
        const statusText = wo.status === 'in_progress' ? 'En cours' : wo.status === 'completed' ? 'Terminé' : 'Planifié';

        return `
        <div class="bg-white rounded-xl p-6 shadow-sm border border-slate-200 hover:shadow-md transition-shadow">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-3">
                    <span class="w-10 h-10 bg-${priorityColor}-100 text-${priorityColor}-600 rounded-lg flex items-center justify-center font-bold text-sm">${wo.number.split('-').pop()}</span>
                    <div>
                        <h3 class="font-bold text-slate-800">${wo.title}</h3>
                        <p class="text-xs text-slate-500">Créé le ${wo.created}</p>
                    </div>
                </div>
                <span class="px-3 py-1 bg-${statusColor}-100 text-${statusColor}-700 rounded-full text-xs font-semibold">${statusText}</span>
            </div>
            <div class="space-y-2 mb-4 text-sm">
                <div class="flex items-center gap-2"><i class="fas fa-wrench text-slate-400 w-5"></i><span class="text-slate-600">Type: ${wo.type}</span></div>
                <div class="flex items-center gap-2"><i class="fas fa-industry text-slate-400 w-5"></i><span class="text-slate-600">Équipement: ${wo.equipment}</span></div>
                <div class="flex items-center gap-2"><i class="fas fa-user text-slate-400 w-5"></i><span class="text-slate-600">Assigné à: ${wo.assigned}</span></div>
                ${wo.scheduled_date ? `<div class="flex items-center gap-2"><i class="fas fa-play-circle text-green-500 w-5"></i><span class="text-slate-600">Intervention: ${wo.scheduled_date}</span></div>` : ''}
                <div class="flex items-center gap-2"><i class="fas fa-calendar text-slate-400 w-5"></i><span class="text-slate-600">Échéance: ${wo.deadline}</span></div>
                <div class="flex items-center gap-2"><i class="fas fa-clock text-slate-400 w-5"></i><span class="text-slate-600">Durée: ${wo.status === 'in_progress' ? `<span class="text-amber-600 font-mono" id="wo-timer-${wo.id}">En cours...</span>` : wo.duration}</span></div>
                <div class="flex items-center gap-2"><i class="fas fa-align-left text-slate-400 w-5"></i><span class="text-slate-600">${wo.description}</span></div>
            </div>
            <div class="flex gap-2">
                <button onclick="viewWorkOrderDetails(${wo.id})" class="flex-1 px-3 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition-colors">Voir détails</button>
                <button onclick="deleteWorkOrder(${wo.id})" class="flex-1 px-3 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 transition-colors"><i class="fas fa-trash mr-1"></i>Supprimer</button>
                ${wo.status === 'planned' && currentUser && currentUser.role !== 'operateur' ? `
                <button onclick="startWorkOrder(${wo.id})" class="flex-1 px-3 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 transition-colors">Démarrer</button>
                ` : ''}
                ${wo.status === 'in_progress' && currentUser && currentUser.role !== 'operateur' ? `
                <button onclick="completeWorkOrder(${wo.id})" class="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors">Clôturer</button>
                ` : ''}
            </div>
        </div>
        `;
    }).join('');
}

function filterWorkOrders(filter) {
    currentWOFilter = filter;
    renderWorkOrdersList();
    updateWOCounts();
}

function updateWOCounts() {
    const counts = {
        all: WORK_ORDERS.length,
        in_progress: WORK_ORDERS.filter(wo => wo.status === 'in_progress').length,
        planned: WORK_ORDERS.filter(wo => wo.status === 'planned').length,
        completed: WORK_ORDERS.filter(wo => wo.status === 'completed').length
    };

    ['all', 'in_progress', 'planned', 'completed'].forEach(status => {
        const el = document.getElementById(`count-wo-${status === 'in_progress' ? 'progress' : status}`);
        if (el) el.textContent = counts[status];
    });
}

function startWorkOrder(woId) {
    const wo = WORK_ORDERS.find(w => w.id === woId);
    if (wo) { wo.status = 'in_progress'; }
    showNotification('OT démarré', `Ordre de travail #${woId} est maintenant en cours.`, 'success');
    renderWorkOrdersList();
    updateWOCounts();
    updateKPIs();
}

function completeWorkOrder(woId) {
    const wo = WORK_ORDERS.find(w => w.id === woId);
    if (wo) {
        wo.status = 'completed';
        wo.completed_date = new Date().toLocaleDateString('fr-FR');

        // Créer automatiquement un rapport d'intervention
        const newReport = {
           id: REPORTS_DATA.length + 1,
           number: `RPT-${String(REPORTS_DATA.length + 1).padStart(3, '0')}`,
           title: wo.title,
           equipment: wo.equipment,
           type: wo.type,
           date: wo.completed_date,
           technician: wo.assigned_to || 'Non assigné',
           duration: wo.estimated_duration || '2h00',
           status: 'Terminé',
           description: wo.description || '',
           wo_number: wo.number,
           checklist: wo.checklist || []
        };
        REPORTS_DATA.unshift(newReport);
    }
    showNotification('OT terminé', `Ordre de travail #${woId} clôturé avec succès.`, 'success');
    renderWorkOrdersList();
    renderReports();
    updateWOCounts();
    updateKPIs();
}

function viewWorkOrderDetails(woId) {
    const wo = WORK_ORDERS.find(w => w.id === woId);
    if (!wo) return;

    const priorityColors = { urgent: 'red', high: 'amber', normal: 'blue', low: 'slate' };
    const priorityLabels = { urgent: 'Urgente', high: 'Haute', normal: 'Normale', low: 'Basse' };
    const statusColors = { in_progress: 'amber', planned: 'blue', completed: 'green' };
    const statusLabels = { in_progress: 'En cours', planned: 'Planifié', completed: 'Terminé' };
    const typeLabels = { Préventive: 'Préventive', Corrective: 'Corrective', Prédictive: 'Prédictive' };

    const color = priorityColors[wo.priority] || 'slate';
    const statusColor = statusColors[wo.status] || 'slate';

    // Historique simulé des actions
    const history = [
        { date: wo.created, action: 'OT créé', user: currentUser?.username || 'Système' },
        ...(wo.status !== 'planned' ? [{ date: wo.created, action: 'OT démarré', user: wo.assigned }] : []),
        ...(wo.status === 'completed' ? [{ date: wo.deadline, action: 'OT terminé', user: wo.assigned }] : [])
    ];

    const modalId = 'workOrderDetailModal';
    let modal = document.getElementById(modalId);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-4">
                <div>
                    <h3 class="text-lg font-bold text-slate-800">${wo.number}</h3>
                    <p class="text-sm text-slate-500">${wo.title}</p>
                </div>
                <button onclick="document.getElementById('${modalId}').classList.remove('active')" class="text-slate-400 hover:text-slate-600">
                    <i class="fas fa-times text-xl"></i>
                </button>
            </div>

            <div class="space-y-4">
                <!-- Badges -->
                <div class="flex gap-2">
                    <span class="px-3 py-1 bg-${color}-100 text-${color}-700 rounded-full text-xs font-semibold">${priorityLabels[wo.priority] || wo.priority}</span>
                    <span class="px-3 py-1 bg-${statusColor}-100 text-${statusColor}-700 rounded-full text-xs font-semibold">${statusLabels[wo.status] || wo.status}</span>
                    <span class="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">${wo.type}</span>
                </div>

                <!-- Infos principales -->
                <div class="grid grid-cols-2 gap-3 text-sm">
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Équipement</p>
                        <p class="font-medium text-slate-800">${wo.equipment}</p>
                    </div>
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Assigné à</p>
                        <p class="font-medium text-slate-800">${wo.assigned}</p>
                    </div>
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Date création</p>
                        <p class="font-medium text-slate-800">${wo.created}</p>
                    </div>
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Échéance</p>
                        <p class="font-medium ${new Date(wo.deadline.split('/').reverse().join('-')) < new Date() ? 'text-red-600' : 'text-slate-800'}">${wo.deadline}</p>
                    </div>
                </div>

                <!-- Description -->
                <div class="p-3 bg-slate-50 rounded-lg">
                    <p class="text-xs text-slate-500 mb-1">Description</p>
                    <p class="text-sm text-slate-700">${wo.description}</p>
                </div>

                <!-- Durée -->
                <div class="p-3 bg-slate-50 rounded-lg">
                    <p class="text-xs text-slate-500 mb-1">Durée estimée</p>
                    <p class="text-sm font-medium text-slate-800">${wo.duration}</p>
                    ${wo.status === 'in_progress' && wo.startTime ? `
                        <p class="text-xs text-amber-600 mt-1">
                            <i class="fas fa-stopwatch mr-1"></i>
                            Temps écoulé: <span id="modal-timer-${wo.id}" class="font-mono font-bold"></span>
                        </p>
                    ` : ''}
                </div>

                <!-- Historique -->
                <div>
                    <p class="text-xs font-semibold text-slate-500 uppercase mb-2">Historique</p>
                    <div class="space-y-2">
                        ${history.map(h => `
                            <div class="flex items-center gap-3 text-sm">
                                <div class="w-2 h-2 bg-blue-400 rounded-full"></div>
                                <span class="text-slate-500 text-xs w-24">${h.date}</span>
                                <span class="text-slate-700">${h.action}</span>
                                <span class="text-slate-400 text-xs ml-auto">${h.user}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <!-- Actions -->
            <div class="mt-6 pt-4 border-t border-slate-200 flex gap-2">
                ${wo.status === 'planned' && currentUser && currentUser.role !== 'operateur' ? `
                    <button onclick="startWorkOrder(${wo.id}); document.getElementById('${modalId}').classList.remove('active');" class="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700">
                        <i class="fas fa-play mr-2"></i>Démarrer
                    </button>
                ` : ''}
                ${wo.status === 'in_progress' && currentUser && currentUser.role !== 'operateur' ? `
                    <button onclick="completeWorkOrder(${wo.id}); document.getElementById('${modalId}').classList.remove('active');" class="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
                        <i class="fas fa-check mr-2"></i>Clôturer
                    </button>
                ` : ''}
                <button onclick="document.getElementById('${modalId}').classList.remove('active')" class="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50">
                    Fermer
                </button>
            </div>
        </div>
    `;

    modal.classList.add('active');

    // Mettre à jour le timer en temps réel si l'OT est en cours
    if (wo.status === 'in_progress' && wo.startTime) {
        const updateModalTimer = () => {
            const timerEl = document.getElementById(`modal-timer-${wo.id}`);
            if (!timerEl) return;
            const elapsed = Math.floor((Date.now() - wo.startTime) / 1000);
            const hours = Math.floor(elapsed / 3600);
            const mins = Math.floor((elapsed % 3600) / 60);
            const secs = elapsed % 60;
            timerEl.textContent = `${hours}h ${mins}m ${secs}s`;
        };
        updateModalTimer();
        const timerInterval = setInterval(() => {
            if (!document.getElementById(`modal-timer-${wo.id}`)) {
                clearInterval(timerInterval);
            } else {
                updateModalTimer();
            }
        }, 1000);
    }
}

function deleteWorkOrder(woId) {
    if (!confirm('Confirmer la suppression de cet OT ?')) return;
    WORK_ORDERS = WORK_ORDERS.filter(w => w.id !== woId);
    renderWorkOrdersList();
    updateWOCounts();
    updateKPIs();
    renderPlanningCalendar();
    showNotification('OT supprimé', 'L\'ordre de travail a été supprimé.', 'success');
}

// ==================== FORMULAIRE NOUVEL OT ====================
function submitWorkOrder(e) {
    e.preventDefault();

    const equipment = document.getElementById('woEquipment');
    const type = document.getElementById('woType');
    const priority = document.getElementById('woPriority');
    const assignee = document.getElementById('woAssignee');
    const title = document.getElementById('woTitle');
    const description = document.getElementById('woDescription');
    const deadlineInput = document.getElementById('woDeadline');
    const durationInput = document.getElementById('woDuration');

    // Vérification que les champs obligatoires existent
    if (!equipment || !type || !priority || !title) {
        console.error('Champs du formulaire manquants:', { equipment, type, priority, title });
        showNotification('Erreur', 'Formulaire incomplet - champs manquants', 'error');
        return;
    }

    // Validation: date d'intervention ne peut pas être dans le passé
    const scheduledInput = document.getElementById('woScheduledDate');
    if (scheduledInput && scheduledInput.value) {
        const scheduledDate = new Date(scheduledInput.value);
        const now = new Date();
        now.setMinutes(now.getMinutes() - 1); // Tolérance 1 minute
        if (scheduledDate < now) {
            showNotification('Erreur', 'La date d\'intervention ne peut pas être dans le passé', 'error');
            scheduledInput.focus();
            return;
        }
    }

    // Validation: échéance ne peut pas être dans le passé
    if (deadlineInput && deadlineInput.value) {
        const deadlineDate = new Date(deadlineInput.value);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (deadlineDate < today) {
            showNotification('Erreur', 'La date d\'échéance ne peut pas être dans le passé', 'error');
            deadlineInput.focus();
            return;
        }
    }

    // Validation: échéance doit être après la date d'intervention
    if (scheduledInput && scheduledInput.value && deadlineInput && deadlineInput.value) {
        const scheduledDate = new Date(scheduledInput.value);
        const deadlineDate = new Date(deadlineInput.value);
        // Ajouter la durée estimée à la date d'intervention pour comparaison
        if (deadlineDate < scheduledDate) {
            showNotification('Erreur', 'L\'échéance doit être après la date d\'intervention', 'error');
            deadlineInput.focus();
            return;
        }
    }

    // Validation du titre
    if (!title.value.trim()) {
        showNotification('Erreur', 'Le titre est obligatoire', 'error');
        title.focus();
        return;
    }

    // Validation du titre
    if (!title.value.trim()) {
        showNotification('Erreur', 'Le titre est obligatoire', 'error');
        title.focus();
        return;
    }

    // Validation de l'échéance (avec fallback si champ absent)
    let deadlineStr;
    if (deadlineInput && deadlineInput.value) {
        const parts = deadlineInput.value.split('-');
        deadlineStr = `${parts[2]}/${parts[1]}/${parts[0]}`;
    } else {
        // Fallback: +7 jours si pas sélectionné ou champ manquant
        const fallbackDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        deadlineStr = fallbackDate.toLocaleDateString('fr-FR');
    }

    // Validation de la durée (avec fallback si champ absent)
    const durationStr = (durationInput && durationInput.value) ? durationInput.value : '2h00';

    const equipMap = { '1': 'Remplisseuse', '2': "Compresseur d'air", '3': 'Convoyeur' };
    const typeMap = { 'preventive': 'Préventive', 'corrective': 'Corrective', 'predictive': 'Prédictive' };

        // Formater la date d'intervention
    let scheduledStr = null;
    if (scheduledInput && scheduledInput.value) {
        const d = new Date(scheduledInput.value);
        scheduledStr = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }

       

        const newWO = {
        id: Date.now(),
        number: `OT-${WORK_ORDERS.length + 24}`,
        title: title.value.trim(),
        type: typeMap[type.value] || type.value,
        status: 'planned',
        priority: priority.value,
        assigned: assignee && assignee.value ? assignee.options[assignee.selectedIndex].text : 'Non assigné',
        scheduled_date: scheduledStr,  // 🔴 AJOUTÉ
        deadline: deadlineStr,
        description: description && description.value ? description.value.trim() : '',
        equipment: equipMap[equipment.value] || equipment.value,
        created: new Date().toLocaleDateString('fr-FR'),
        duration: durationInput && durationInput.value ? durationInput.value : '2h00'
    };

    WORK_ORDERS.unshift(newWO);
    showNotification('Ordre de travail créé', `Le nouvel OT ${newWO.number} a été créé avec succès.`, 'success');
    closeModal('newWorkOrderModal');
    
    // Réinitialiser le formulaire
    const form = document.getElementById('workOrderForm');
    if (form) form.reset();
    
    // Réinitialiser la date par défaut si le champ existe
    setTimeout(() => {
        const dlInput = document.getElementById('woDeadline');
        if (dlInput) {
            const defaultDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            dlInput.value = defaultDate.toISOString().split('T')[0];
        }
    }, 100);
    

    renderWorkOrdersList();
    updateWOCounts();
    updateKPIs();
    renderPlanningCalendar();
    renderUpcomingMaintenance();
    renderMaintenanceFreq();
    
    
    //  AUSSI: si l'OT a une date d'échéance, l'ajouter visuellement au calendrier
    // même si on n'est pas sur la section planification (pour qu'il soit là au prochain affichage)
    if (newWO.deadline) {
        // Forcer la mise à jour des données de planification
        const deadlineParts = newWO.deadline.split('/');
        if (deadlineParts.length === 3) {
            const woMonth = parseInt(deadlineParts[1]) - 1; // 0-11
            const woYear = parseInt(deadlineParts[2]);
            
            // Si le calendrier affiche le mois de l'OT, on le rafraîchit
            if (woMonth === currentPlanningMonth && woYear === currentPlanningYear) {
                // Déjà fait ci-dessus si on est sur la section
            }
        }
    }
}


function triggerWorkOrder(alarmTitle) {
    showModal('newWorkOrderModal');
    
    // Pré-remplir la description
    const descField = document.querySelector('#newWorkOrderModal textarea');
    if (descField) descField.value = `Intervention suite à l'alarme: ${alarmTitle}`;
    
    // Initialiser les dates minimales (aujourd'hui)
    initWorkOrderDateConstraints();
}

function initWorkOrderDateConstraints() {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD pour input date
    const nowStr = now.toISOString().slice(0, 16);    // YYYY-MM-DDTHH:mm pour datetime-local
    
    const deadlineInput = document.getElementById('woDeadline');
    const scheduledInput = document.getElementById('woScheduledDate');
    
    if (deadlineInput) {
        deadlineInput.min = todayStr;
        // Date par défaut: +7 jours
        const defaultDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        deadlineInput.value = defaultDate.toISOString().split('T')[0];
    }
    
    if (scheduledInput) {
        scheduledInput.min = nowStr;
        // Date par défaut: demain à 8h
        const defaultScheduled = new Date(Date.now() + 24 * 60 * 60 * 1000);
        defaultScheduled.setHours(8, 0, 0, 0);
        scheduledInput.value = defaultScheduled.toISOString().slice(0, 16);
    }
}

// ==================== DÉTAIL ÉQUIPEMENT (MODAL) ====================
function showEquipmentDetail(equipmentType) {
    const equip = EQUIPMENTS_DATA[equipmentType];
    if (!equip) return;

    document.getElementById('equipmentModalTitle').textContent = `${equip.name} - ${equip.station}`;

    let metricsHtml = '<div class="grid grid-cols-2 gap-4">';
    Object.entries(equip.sensors).forEach(([type, sensor]) => {
        const statusColor = sensor.status === 'critical' ? 'red' : sensor.status === 'warning' ? 'amber' : 'green';
        metricsHtml += `
            <div class="p-4 bg-slate-50 rounded-lg border-l-4 border-${statusColor}-500">
                <div class="flex justify-between items-start">
                    <p class="text-sm text-slate-500 capitalize">${sensorKeyToLabel(type)}</p>
                    <span class="text-xs px-2 py-0.5 bg-${statusColor}-100 text-${statusColor}-700 rounded">${sensor.status === 'normal' ? 'Normal' : sensor.status === 'warning' ? 'Attention' : 'Critique'}</span>
                </div>
                <p class="text-2xl font-bold text-slate-800 mt-1">${sensor.value.toFixed(1)} <span class="text-sm text-slate-400">${sensor.unit}</span></p>
                <div class="mt-2 space-y-1">
                    <div class="flex justify-between text-xs text-slate-400"><span>Seuil</span><span>${sensor.threshold}${sensor.unit}</span></div>
                    <div class="w-full bg-slate-200 rounded-full h-1.5"><div class="h-1.5 rounded-full bg-${statusColor}-500 transition-all" style="width: ${Math.min(100, (sensor.value / sensor.critical) * 100)}%"></div></div>
                    <div class="flex justify-between text-xs text-slate-400"><span>Critique</span><span>${sensor.critical}${sensor.unit}</span></div>
                </div>
                <p class="text-xs text-slate-400 mt-2"><i class="fas fa-microchip mr-1"></i>Pin ESP32: ${sensor.pin}</p>
            </div>
        `;
    });
    metricsHtml += '</div>';

    metricsHtml += `
        <div class="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <h4 class="font-bold text-blue-800 mb-2"><i class="fas fa-wifi mr-2"></i>Configuration ESP32</h4>
            <div class="grid grid-cols-2 gap-4 text-sm">
                <div><span class="text-slate-500">IP:</span> <span class="font-mono text-slate-700">${equip.esp32_ip || '192.168.1.100'}</span></div>
                <div><span class="text-slate-500">Port:</span> <span class="font-mono text-slate-700">${equip.esp32_port || '8080'}</span></div>
                <div><span class="text-slate-500">Équipement ID:</span> <span class="font-mono text-slate-700">${equip.id}</span></div>
                <div><span class="text-slate-500">Statut:</span> <span class="font-mono text-${equip.status === 'en_marche' ? 'green' : 'amber'}-600">${equip.status}</span></div>
            </div>
        </div>
        <div class="mt-4 flex gap-2">
            <button onclick="createOTFromEquipment('${equipmentType}')" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"><i class="fas fa-plus mr-2"></i>Créer un OT</button>
            <button onclick="viewHistory('${equipmentType}')" class="flex-1 px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors"><i class="fas fa-history mr-2"></i>Historique</button>
        </div>
    `;

    document.getElementById('equipmentModalContent').innerHTML = metricsHtml;
    showModal('equipmentModal');
}

function createOTFromEquipment(equipmentType) {
    closeModal('equipmentModal');
    showModal('newWorkOrderModal');
    
    const equipMap = { 'remplisseuse': '1', 'compresseur': '2', 'convoyeur': '3' };
    
    setTimeout(() => {
        const equipSelect = document.getElementById('woEquipment');
        const titleInput = document.getElementById('woTitle');
        const descInput = document.getElementById('woDescription');
        const deadlineInput = document.getElementById('woDeadline');
        
        if (equipSelect && equipMap[equipmentType]) equipSelect.value = equipMap[equipmentType];
        if (titleInput) titleInput.value = `Intervention ${EQUIPMENTS_DATA[equipmentType].name}`;
        if (descInput) descInput.value = `Problème détecté sur ${EQUIPMENTS_DATA[equipmentType].name} - Intervention requise`;
        
        // Date par défaut +7 jours
        if (deadlineInput) {
            const defaultDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            deadlineInput.value = defaultDate.toISOString().split('T')[0];
        }
        
    }, 100);
    // Initialiser les contraintes de date
        initWorkOrderDateConstraints();
}

function viewHistory(equipmentType) {
    showNotification('Historique', `Affichage de l'historique de ${EQUIPMENTS_DATA[equipmentType].name}`, 'info');
}

// ==================== MODALS ====================
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
}

// Fermer en cliquant à l'extérieur
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal') && e.target.classList.contains('active')) {
        e.target.classList.remove('active');
    }
});

// ==================== PLANIFICATION - CALENDRIER DYNAMIQUE ====================
function renderPlanningCalendar() {
    const container = document.getElementById('planningCalendar');
    if (!container) return;

    // Mettre à jour le titre du mois
    const titleEl = document.getElementById('planningTitle');
    if (titleEl) {
        titleEl.textContent = `Planification Préventive - ${MONTH_NAMES[currentPlanningMonth]} ${currentPlanningYear}`;
    }
    const year = currentPlanningYear;
    const month = currentPlanningMonth;
    const firstDay = new Date(currentPlanningYear, currentPlanningMonth, 1);
    const lastDay = new Date(currentPlanningYear, currentPlanningMonth + 1, 0);
    const startOffset = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;
    const daysInMonth = lastDay.getDate();
    const today = new Date();
    const isCurrentMonth = today.getMonth() === currentPlanningMonth && today.getFullYear() === currentPlanningYear;

    let html = '';

    // Jours vides avant le 1er
    for (let i = 0; i < startOffset; i++) {
        html += `<div class="h-24 bg-slate-50 rounded-lg border border-slate-100"></div>`;
    }

    // Jours du mois
    for (let day = 1; day <= daysInMonth; day++) {
        const dateObj = new Date(currentPlanningYear, currentPlanningMonth, day);
        const dateStr = `${String(day).padStart(2, '0')}/${String(currentPlanningMonth + 1).padStart(2, '0')}/${currentPlanningYear}`;
        
        // Chercher les maintenances ET les OT planifiés pour cette date
        const dayMaintenances = MAINTENANCE_PLAN.filter(m => m.next_date === dateStr);
        const dayWorkOrders = WORK_ORDERS.filter(wo => {
            if (wo.status === 'completed') return false;
            return wo.deadline === dateStr;
        });
        
        const allEvents = [...dayMaintenances, ...dayWorkOrders.map(wo => ({
            equipment: wo.equipment,
            type: wo.type,
            id: wo.id,
            isWO: true,
            priority: wo.priority
        }))];

        const isToday = isCurrentMonth && day === today.getDate();
        const isPast = dateObj < new Date(today.getFullYear(), today.getMonth(), today.getDate());

        let eventsHtml = '';
        const colors = { 
            Préventive: 'blue', Corrective: 'red', Prédictive: 'purple', 
            'Préventive': 'blue', 'Corrective': 'red', 'Prédictive': 'purple' 
        };
        
        allEvents.slice(0, 3).forEach(ev => {
            const color = colors[ev.type] || 'slate';
            const icon = ev.isWO ? 'fa-clipboard-list' : 'fa-wrench';
            eventsHtml += `
                <div class="text-xs px-1.5 py-0.5 bg-${color}-100 text-${color}-700 rounded mb-1 truncate flex items-center gap-1" 
                     title="${ev.equipment} - ${ev.type}${ev.isWO ? ' (OT)' : ''}">
                    <i class="fas ${icon} text-[10px]"></i>
                    ${ev.equipment}
                </div>
            `;
        });

        const hasMore = allEvents.length > 3;

        html += `
            <div class="h-24 bg-white rounded-lg border ${isToday ? 'border-blue-400 ring-2 ring-blue-100' : isPast ? 'border-slate-200 opacity-60' : 'border-slate-200'} p-1.5 relative hover:shadow-md transition-shadow cursor-pointer overflow-hidden" 
                 onclick="showDayDetails('${dateStr}')">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-sm font-semibold ${isToday ? 'text-blue-600' : 'text-slate-700'}">${day}</span>
                    ${isToday ? '<span class="text-[10px] bg-blue-100 text-blue-700 px-1.5 rounded">Auj.</span>' : ''}
                    ${isPast && !isToday ? '<span class="text-[10px] text-slate-400">passé</span>' : ''}
                </div>
                <div class="mt-0.5 space-y-0.5 overflow-hidden">
                    ${eventsHtml}
                </div>
                ${hasMore ? `<div class="text-xs text-slate-400 text-center mt-0.5">+${allEvents.length - 3}</div>` : ''}
            </div>
        `;
    }

    // Jours vides après le dernier jour pour compléter la grille (optionnel mais propre)
    const totalCells = startOffset + daysInMonth;
    const remainingCells = (7 - (totalCells % 7)) % 7;
    for (let i = 0; i < remainingCells; i++) {
        html += `<div class="h-24 bg-slate-50 rounded-lg border border-slate-100"></div>`;
    }

    container.innerHTML = html;
}

function previousMonth() {
    currentPlanningMonth--;
    if (currentPlanningMonth < 0) {
        currentPlanningMonth = 11;
        currentPlanningYear--;
    }
    renderPlanningCalendar();
    renderUpcomingMaintenance();
    renderMaintenanceFreq();
    showNotification('Calendrier', `${MONTH_NAMES[currentPlanningMonth]} ${currentPlanningYear}`, 'info');
}

function nextMonth() {
    currentPlanningMonth++;
    if (currentPlanningMonth > 11) {
        currentPlanningMonth = 0;
        currentPlanningYear++;
    }
    renderPlanningCalendar();
    renderUpcomingMaintenance();
    renderMaintenanceFreq();
    showNotification('Calendrier', `${MONTH_NAMES[currentPlanningMonth]} ${currentPlanningYear}`, 'info');
}

function goToToday() {
    const today = new Date();
    currentPlanningMonth = today.getMonth();
    currentPlanningYear = today.getFullYear();
    renderPlanningCalendar();
    renderUpcomingMaintenance();
    renderMaintenanceFreq();
    showNotification('Calendrier', 'Retour à aujourd\'hui', 'success');
}

function showDayDetails(dateStr) {
    selectedPlanningDate = dateStr;
    
    // Combiner maintenances planifiées et OT
    const maintenances = MAINTENANCE_PLAN.filter(m => m.next_date === dateStr);
    const workOrders = WORK_ORDERS.filter(wo => wo.deadline === dateStr && wo.status !== 'completed');
    
    const allEvents = [
        ...maintenances.map(m => ({ ...m, isWO: false })),
        ...workOrders.map(wo => ({
            equipment: wo.equipment,
            type: wo.type,
            duration: wo.duration,
            technician: wo.assigned,
            id: wo.id,
            isWO: true,
            priority: wo.priority,
            status: wo.status,
            title: wo.title
        }))
    ];

    if (allEvents.length === 0) {
        // Proposer de créer une maintenance
        if (confirm(`Aucune maintenance le ${dateStr}. Créer un nouvel ordre de travail ?`)) {
            showModal('newWorkOrderModal');
            const dateParts = dateStr.split('/');
            const isoDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
            // On pourrait pré-remplir la date ici si le formulaire avait un champ date
        }
        return;
    }

    const listHtml = allEvents.map(ev => {
        const colors = { Préventive: 'blue', Corrective: 'red', Prédictive: 'purple', 
                        'Préventive': 'blue', 'Corrective': 'red', 'Prédictive': 'purple' };
        const color = colors[ev.type] || 'slate';
        
        return `
            <div class="p-3 bg-${color}-50 rounded-lg border border-${color}-200 mb-2">
                <div class="flex justify-between items-start">
                    <div>
                        <p class="font-semibold text-${color}-800">${ev.equipment}</p>
                        <p class="text-sm text-${color}-600">${ev.isWO ? ev.title : ev.type} ${ev.isWO ? `<span class="text-xs bg-amber-100 text-amber-700 px-1 rounded">OT</span>` : ''}</p>
                        <p class="text-xs text-slate-500 mt-1">
                            <i class="fas fa-clock mr-1"></i>${ev.duration} 
                            <i class="fas fa-user ml-2 mr-1"></i>${ev.technician}
                        </p>
                    </div>
                    ${ev.isWO ? `
                        <button onclick="viewWorkOrderDetails(${ev.id})" class="text-xs bg-white border border-slate-300 px-2 py-1 rounded hover:bg-slate-50">
                            Voir OT
                        </button>
                    ` : `
                        <button onclick="createOTFromMaintenance(${ev.id})" class="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700">
                            Créer OT
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join('');

    // Créer un modal dynamique pour les détails du jour
    const modalId = 'dayDetailsModal';
    let modal = document.getElementById(modalId);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal';
        document.body.appendChild(modal);
    }
    
    modal.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-slate-800">Détails du ${dateStr}</h3>
                <button onclick="document.getElementById('${modalId}').classList.remove('active')" class="text-slate-400 hover:text-slate-600">
                    <i class="fas fa-times text-xl"></i>
                </button>
            </div>
            <div class="max-h-96 overflow-y-auto">
                ${listHtml}
            </div>
            <div class="mt-4 pt-4 border-t border-slate-200 flex gap-2">
                <button onclick="showModal('newWorkOrderModal'); document.getElementById('${modalId}').classList.remove('active');" 
                        class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                    <i class="fas fa-plus mr-2"></i>Nouvel OT
                </button>
                <button onclick="document.getElementById('${modalId}').classList.remove('active')" 
                        class="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50">
                    Fermer
                </button>
            </div>
        </div>
    `;
    
    modal.classList.add('active');
}

// ==================== PLANIFICATION - PROCHAINES MAINTENANCES DYNAMIQUES ====================
function renderUpcomingMaintenance() {
    const container = document.getElementById('upcomingMaintenance');
    if (!container) return;

    // Combiner MAINTENANCE_PLAN + OT planifiés non complétés
    const allTasks = [
        ...MAINTENANCE_PLAN.filter(m => m.next_date !== '-').map(m => ({
            ...m,
            source: 'plan',
            daysLeft: Math.ceil((new Date(m.next_date.split('/').reverse().join('-')) - new Date()) / (1000 * 60 * 60 * 24))
        })),
        ...WORK_ORDERS.filter(wo => wo.status !== 'completed').map(wo => ({
            id: wo.id,
            equipment: wo.equipment,
            type: wo.type,
            frequency: 'OT Planifié',
            next_date: wo.deadline,
            last_date: wo.created,
            duration: wo.duration,
            technician: wo.assigned,
            source: 'wo',
            priority: wo.priority,
            daysLeft: Math.ceil((new Date(wo.deadline.split('/').reverse().join('-')) - new Date()) / (1000 * 60 * 60 * 24))
        }))
    ].sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 6);

    if (allTasks.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8">
                <i class="fas fa-calendar-check text-slate-300 text-3xl mb-2"></i>
                <p class="text-sm text-slate-400">Aucune maintenance prévue</p>
            </div>
        `;
        return;
    }

    container.innerHTML = allTasks.map(m => {
        const colors = { Préventive: 'blue', Corrective: 'red', Prédictive: 'purple', 'OT Planifié': 'amber' };
        const color = colors[m.type] || 'slate';
        const isUrgent = m.daysLeft <= 2 && m.daysLeft >= 0;
        const isOverdue = m.daysLeft < 0;

        return `
            <div class="flex items-center justify-between p-3 bg-slate-50 rounded-lg border-l-4 border-${color}-500 hover:bg-slate-100 transition-colors group">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold text-slate-800 truncate">${m.equipment}</span>
                        <span class="text-xs px-1.5 py-0.5 bg-${color}-100 text-${color}-700 rounded shrink-0">${m.type}</span>
                        ${m.source === 'wo' ? '<span class="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded shrink-0">OT</span>' : ''}
                    </div>
                    <p class="text-xs text-slate-500 mt-0.5">${m.frequency} • ${m.duration} • ${m.technician}</p>
                </div>
                <div class="text-right shrink-0 ml-3">
                    <p class="text-sm font-medium ${isOverdue ? 'text-red-600' : isUrgent ? 'text-amber-600' : 'text-slate-700'}">
                        ${isOverdue ? 'En retard !' : m.daysLeft === 0 ? 'Aujourd\'hui' : `J-${m.daysLeft}`}
                    </p>
                    <p class="text-xs ${isOverdue ? 'text-red-500' : 'text-slate-400'}">${m.next_date}</p>
                </div>
                <div class="ml-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                    ${m.source === 'plan' ? `
                        <button onclick="createOTFromMaintenance(${m.id})" class="p-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700" title="Créer un OT">
                            <i class="fas fa-plus"></i>
                        </button>
                    ` : `
                        <button onclick="viewWorkOrderDetails(${m.id})" class="p-1.5 bg-slate-600 text-white rounded text-xs hover:bg-slate-700" title="Voir l'OT">
                            <i class="fas fa-eye"></i>
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join('');
}

function createOTFromMaintenance(planId) {
    const plan = MAINTENANCE_PLAN.find(p => p.id === planId);
    if (!plan) return;
    
    // Pré-remplir le formulaire OT
    const equipMap = { 'Remplisseuse': '1', "Compresseur d'air": '2', 'Convoyeur': '3' };
    
    showModal('newWorkOrderModal');
    setTimeout(() => {
        const equipSelect = document.getElementById('woEquipment');
        const typeSelect = document.getElementById('woType');
        const titleInput = document.getElementById('woTitle');
        const descInput = document.getElementById('woDescription');
        const deadlineInput = document.getElementById('woDeadline');
        const durationInput = document.getElementById('woDuration');
        
        if (equipSelect && equipMap[plan.equipment]) equipSelect.value = equipMap[plan.equipment];
        if (typeSelect) {
            const typeValue = plan.type === 'Préventive' ? 'preventive' : 
                           plan.type === 'Corrective' ? 'corrective' : 'predictive';
            typeSelect.value = typeValue;
        }
        if (titleInput) titleInput.value = `${plan.type} - ${plan.equipment}`;
        if (descInput) descInput.value = `Maintenance ${plan.frequency.toLowerCase()} planifiée pour ${plan.equipment}. Technicien: ${plan.technician}`;
        
        // Pré-remplir l'échéance avec la date de la maintenance planifiée
        if (deadlineInput && plan.next_date && plan.next_date !== '-') {
            const parts = plan.next_date.split('/');
            if (parts.length === 3) {
                deadlineInput.value = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }
        }
        
        // Pré-remplir la durée
        if (durationInput && plan.duration) {
            // Essayer de matcher la durée avec les options disponibles
            const durationMap = {
                '30m': '0h30', '1h': '1h00', '1h30': '1h30', '2h': '2h00',
                '2h30': '2h30', '3h': '3h00', '4h': '4h00', '6h': '6h00', '8h': '8h00'
            };
            const matched = Object.keys(durationMap).find(k => plan.duration.toLowerCase().includes(k));
            if (matched) durationInput.value = durationMap[matched];
        }
        // Initialiser les contraintes de date
        initWorkOrderDateConstraints();
    }, 100);
    
    showNotification('Pré-remplissage', `Formulaire pré-rempli pour ${plan.equipment}`, 'info');
}

function showMaintenanceDetail(id) {
    const m = MAINTENANCE_PLAN.find(p => p.id === id);
    if (!m) return;
    showNotification('Maintenance', `${m.equipment}: ${m.type} prévue le ${m.next_date}`, 'info');
}

// ==================== PLANIFICATION - FRÉQUENCES ====================
function renderMaintenanceFreq() {
    const container = document.getElementById('maintenanceFreq');
    if (!container) return;

    const freqs = {};
    MAINTENANCE_PLAN.forEach(m => {
        if (!freqs[m.equipment]) freqs[m.equipment] = [];
        freqs[m.equipment].push(m);
    });

    container.innerHTML = Object.entries(freqs).map(([equip, items]) => {
        return `
            <div class="space-y-2">
                <div class="flex items-center justify-between">
                    <h4 class="font-medium text-slate-800">${equip}</h4>
                    <span class="text-xs text-slate-500">${items.length} planifiée${items.length > 1 ? 's' : ''}</span>
                </div>
                <div class="space-y-1.5">
                    ${items.map(m => {
                        const colors = { Préventive: 'blue', Corrective: 'red', Prédictive: 'purple' };
                        const color = colors[m.type] || 'slate';
                        return `
                            <div class="flex items-center justify-between text-sm p-2 bg-${color}-50 rounded border border-${color}-100">
                                <span class="text-${color}-800">${m.type}</span>
                                <span class="text-xs text-${color}-600">${m.frequency}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }).join('');
}

// ==================== RAPPORTS - TABLE ====================
// ==================== RAPPORTS - TABLE DYNAMIQUE AVEC FILTRES ====================
function renderReports() {
    const tbody = document.getElementById('reportsTable');
    const container = document.getElementById('reportsSection');
    if (!tbody || !container) return;

    // Créer la barre de filtres si elle n'existe pas
    let filterBar = document.getElementById('reportsFilterBar');
    if (!filterBar) {
        filterBar = document.createElement('div');
        filterBar.id = 'reportsFilterBar';
        filterBar.className = 'bg-white rounded-xl p-4 shadow-sm border border-slate-200 mb-4 flex flex-wrap gap-3 items-center';
        container.insertBefore(filterBar, container.children[1]); // Après le titre
    }

    filterBar.innerHTML = `
        <div class="flex items-center gap-2">
            <i class="fas fa-filter text-slate-400"></i>
            <select id="reportFilterEquip" onchange="updateReportFilter('equipment', this.value)" class="px-3 py-1.5 border border-slate-300 rounded-lg text-sm">
                <option value="all">Tous équipements</option>
                <option value="Remplisseuse">Remplisseuse</option>
                <option value="Compresseur d'air">Compresseur</option>
                <option value="Convoyeur">Convoyeur</option>
            </select>
        </div>
        <select id="reportFilterType" onchange="updateReportFilter('type', this.value)" class="px-3 py-1.5 border border-slate-300 rounded-lg text-sm">
            <option value="all">Tous types</option>
            <option value="Préventive">Préventive</option>
            <option value="Corrective">Corrective</option>
            <option value="Prédictive">Prédictive</option>
        </select>
        <select id="reportFilterStatus" onchange="updateReportFilter('status', this.value)" class="px-3 py-1.5 border border-slate-300 rounded-lg text-sm">
            <option value="all">Tous statuts</option>
            <option value="validé">Validé</option>
            <option value="en_attente">En attente</option>
            <option value="rejeté">Rejeté</option>
        </select>
        <div class="flex items-center gap-2 ml-auto">
            <input type="text" id="reportSearch" placeholder="Rechercher..." 
                   oninput="updateReportFilter('search', this.value)"
                   class="px-3 py-1.5 border border-slate-300 rounded-lg text-sm w-48" value="${reportFilter.search}">
            <span id="reportCount" class="text-sm text-slate-500 font-medium"></span>
        </div>
    `;

    // Réappliquer les valeurs des filtres
    setTimeout(() => {
        const equipSel = document.getElementById('reportFilterEquip');
        const typeSel = document.getElementById('reportFilterType');
        const statusSel = document.getElementById('reportFilterStatus');
        if (equipSel) equipSel.value = reportFilter.equipment;
        if (typeSel) typeSel.value = reportFilter.type;
        if (statusSel) statusSel.value = reportFilter.status;
    }, 0);

    // Filtrer les données
    let filtered = REPORTS_DATA.filter(r => {
        if (reportFilter.equipment !== 'all' && r.equipment !== reportFilter.equipment) return false;
        if (reportFilter.type !== 'all' && r.type !== reportFilter.type) return false;
        if (reportFilter.status !== 'all' && r.status !== reportFilter.status) return false;
        if (reportFilter.search) {
            const search = reportFilter.search.toLowerCase();
            const searchFields = [r.number, r.equipment, r.technician, r.description, r.type].join(' ').toLowerCase();
            if (!searchFields.includes(search)) return false;
        }
        return true;
    });

    // Trier
    filtered.sort((a, b) => {
        let valA, valB;
        if (reportSort.field === 'date') {
            valA = a.date.split('/').reverse().join('');
            valB = b.date.split('/').reverse().join('');
        } else if (reportSort.field === 'duration') {
            valA = parseDuration(a.duration);
            valB = parseDuration(b.duration);
        } else {
            valA = a[reportSort.field] || '';
            valB = b[reportSort.field] || '';
        }
        return reportSort.direction === 'asc' ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
    });

    // Mettre à jour le compteur
    const countEl = document.getElementById('reportCount');
    if (countEl) countEl.textContent = `${filtered.length} rapport${filtered.length > 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-8 text-center text-slate-400">
            <i class="fas fa-search text-slate-300 text-2xl mb-2"></i><br>
            Aucun rapport ne correspond aux critères
        </td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(report => {
        const statusColors = { validé: 'green', en_attente: 'amber', rejeté: 'red' };
        const statusLabels = { validé: 'Validé', en_attente: 'En attente', rejeté: 'Rejeté' };

        return `
            <tr class="hover:bg-slate-50 transition-colors group">
                <td class="px-6 py-4 font-medium text-slate-800">${report.number}</td>
                <td class="px-6 py-4 text-slate-600">${report.date}</td>
                <td class="px-6 py-4 text-slate-700">${report.equipment}</td>
                <td class="px-6 py-4"><span class="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">${report.type}</span></td>
                <td class="px-6 py-4 text-slate-600">${report.technician}</td>
                <td class="px-6 py-4 text-slate-600 font-mono">${report.duration}</td>
                <td class="px-6 py-4">
                    <span class="px-2 py-0.5 bg-${statusColors[report.status] || 'slate'}-100 text-${statusColors[report.status] || 'slate'}-700 rounded text-xs font-medium">
                        ${statusLabels[report.status] || report.status}
                    </span>
                </td>
                <td class="px-6 py-4">
                    <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick="viewReport(${report.id})" class="text-blue-600 hover:text-blue-800 text-sm font-medium">Voir</button>
                        <button onclick="editReportStatus(${report.id})" class="text-amber-600 hover:text-amber-800 text-sm"><i class="fas fa-edit"></i></button>
                        <button onclick="downloadReport(${report.id})" class="text-slate-400 hover:text-slate-600 text-sm"><i class="fas fa-download"></i></button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function updateReportFilter(field, value) {
    reportFilter[field] = value;
    renderReports();
}

function parseDuration(durStr) {
    const parts = durStr.split('h');
    const hours = parseInt(parts[0]) || 0;
    const mins = parseInt(parts[1]) || 0;
    return hours * 60 + mins;
}

function editReportStatus(reportId) {
    const report = REPORTS_DATA.find(r => r.id === reportId);
    if (!report) return;
    
    const statuses = ['validé', 'en_attente', 'rejeté'];
    const currentIdx = statuses.indexOf(report.status);
    const nextStatus = statuses[(currentIdx + 1) % statuses.length];
    
    report.status = nextStatus;
    showNotification('Statut mis à jour', `Rapport ${report.number}: ${nextStatus}`, 'success');
    renderReports();
}

function viewReport(id) {
    const report = REPORTS_DATA.find(r => r.id === id);
    if (!report) return;

    const statusColors = { validé: 'green', en_attente: 'amber', rejeté: 'red' };
    const statusLabels = { validé: 'Validé', en_attente: 'En attente', rejeté: 'Rejeté' };
    const typeColors = { Préventive: 'blue', Corrective: 'red', Prédictive: 'purple' };

    const modalId = 'reportDetailModal';
    let modal = document.getElementById(modalId);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-4">
                <div>
                    <h3 class="text-lg font-bold text-slate-800">${report.number}</h3>
                    <p class="text-sm text-slate-500">Rapport d'intervention</p>
                </div>
                <button onclick="document.getElementById('${modalId}').classList.remove('active')" class="text-slate-400 hover:text-slate-600">
                    <i class="fas fa-times text-xl"></i>
                </button>
            </div>

            <div class="space-y-4">
                <!-- Badges -->
                <div class="flex gap-2">
                    <span class="px-3 py-1 bg-${typeColors[report.type] || 'slate'}-100 text-${typeColors[report.type] || 'slate'}-700 rounded-full text-xs font-semibold">${report.type}</span>
                    <span class="px-3 py-1 bg-${statusColors[report.status] || 'slate'}-100 text-${statusColors[report.status] || 'slate'}-700 rounded-full text-xs font-semibold">${statusLabels[report.status] || report.status}</span>
                </div>

                <!-- Infos -->
                <div class="grid grid-cols-2 gap-3 text-sm">
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Date</p>
                        <p class="font-medium text-slate-800">${report.date}</p>
                    </div>
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Durée</p>
                        <p class="font-medium text-slate-800">${report.duration}</p>
                    </div>
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Équipement</p>
                        <p class="font-medium text-slate-800">${report.equipment}</p>
                    </div>
                    <div class="p-3 bg-slate-50 rounded-lg">
                        <p class="text-xs text-slate-500 mb-1">Technicien</p>
                        <p class="font-medium text-slate-800">${report.technician}</p>
                    </div>
                </div>

                <!-- Description -->
                <div class="p-3 bg-slate-50 rounded-lg">
                    <p class="text-xs text-slate-500 mb-1">Description de l'intervention</p>
                    <p class="text-sm text-slate-700">${report.description}</p>
                </div>

                <!-- Détails simulés -->
                <div class="p-3 bg-slate-50 rounded-lg">
                    <p class="text-xs font-semibold text-slate-500 mb-2">Détails de l'intervention</p>
                    <div class="space-y-2 text-sm text-slate-600">
                        <p><i class="fas fa-check-circle text-green-500 mr-2"></i>Diagnostic effectué</p>
                        <p><i class="fas fa-check-circle text-green-500 mr-2"></i>Pièces de rechange utilisées</p>
                        <p><i class="fas fa-check-circle text-green-500 mr-2"></i>Tests de fonctionnement OK</p>
                        <p><i class="fas fa-check-circle text-green-500 mr-2"></i>Nettoyage et rangement</p>
                    </div>
                </div>
            </div>

            <div class="mt-6 pt-4 border-t border-slate-200 flex gap-2">
                <button onclick="downloadReport(${report.id});" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
    <i class="fas fa-download mr-2"></i>Télécharger
</button>
                <button onclick="" class="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50">
                    Fermer
                </button>
            </div>
        </div>
    `;

    modal.classList.add('active');
}

function downloadReport(id) {
    const report = REPORTS_DATA.find(r => r.id === id);
    if (!report) return;

    const statusLabels = { validé: 'Validé', en_attente: 'En attente', rejeté: 'Rejeté' };
    const { jsPDF } = window.jspdf;

    // Créer le PDF
    const doc = new jsPDF();
    
    // En-tête
    doc.setFillColor(102, 126, 234);
    doc.rect(0, 0, 210, 40, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.text('RAPPORT D\'INTERVENTION', 105, 25, { align: 'center' });
    
    // Numéro et date
    doc.setTextColor(100, 100, 100);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`${report.wo_number || report.number  || ''} | ${report.date}`, 105, 35, { align: 'center' });
    
    // Contenu
    let y = 55;
    const lineHeight = 8;
    
    // Fonction helper pour les sections
    function addSection(title, yPos) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(102, 126, 234);
        doc.text(title, 20, yPos);
        doc.setDrawColor(102, 126, 234);
        doc.line(20, yPos + 2, 190, yPos + 2);
        return yPos + 10;
    }
    
    function addLabelValue(label, value, yPos, xLabel = 20, xValue = 70) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(80, 80, 80);
        doc.text(label + ':', xLabel, yPos);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(50, 50, 50);
        doc.text(String(value), xValue, yPos);
        return yPos + lineHeight;
    }
    
    // Section Informations générales
    y = addSection('INFORMATIONS GÉNÉRALES', y);
    y = addLabelValue('Équipement', report.equipment, y);
    y = addLabelValue('Type d\'intervention', report.type, y);
    y = addLabelValue('Technicien', report.technician, y);
    y = addLabelValue('Durée', report.duration, y);
    y = addLabelValue('Date', report.date, y);
    y = addLabelValue('Statut', statusLabels[report.status] || report.status, y);
    y += 5;
    
    // Section Description
    y = addSection('DESCRIPTION', y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(50, 50, 50);
    const splitDesc = doc.splitTextToSize(report.description, 170);
    doc.text(splitDesc, 20, y);
    y += splitDesc.length * lineHeight + 5;
    
    // Section Détails de l'intervention
    y = addSection('DÉTAILS DE L\'INTERVENTION', y);
    const details = report.checklist && report.checklist.length > 0 
    ? report.checklist 
    : [
        'Diagnostic initial effectué',
        'Identification des pièces défectueuses',
        'Remplacement / réparation effectué(e)',
        'Tests de fonctionnement validés',
        'Nettoyage et remise en état'
    ];
    details.forEach((detail, i) => {
        doc.setTextColor(39, 174, 96);
        doc.text('✓', 25, y + (i * lineHeight));
        doc.setTextColor(50, 50, 50);
        doc.text(detail, 35, y + (i * lineHeight));
    });
    y += details.length * lineHeight + 10;
    
    // Section Signatures (si assez de place, sinon nouvelle page)
    if (y > 230) {
        doc.addPage();
        y = 30;
    }
    y = addSection('SIGNATURES', y);
    y += 10;
    
    doc.setFontSize(10);
    doc.setTextColor(80, 80, 80);
    doc.text('Technicien:', 20, y);
    doc.text('Date:', 120, y);
    y += 8;
    doc.setDrawColor(150, 150, 150);
    doc.line(20, y, 80, y);
    doc.line(120, y, 180, y);
    y += 20;
    
    doc.text('Superviseur:', 20, y);
    doc.text('Date:', 120, y);
    y += 8;
    doc.line(20, y, 80, y);
    doc.line(120, y, 180, y);
    
    // Pied de page
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(`Smart Maintenance - Système de Maintenance Prédictive | Page ${i}/${pageCount}`, 105, 285, { align: 'center' });
        doc.text(`Généré le ${new Date().toLocaleString('fr-FR')}`, 105, 290, { align: 'center' });
    }
    
    // Télécharger
    const fileName = `${report.number}_${report.equipment.replace(/\s+/g, '_')}_${report.date.replace(/\//g, '-')}.pdf`;
    doc.save(fileName);

    showNotification('Téléchargement', `Rapport ${report.number} téléchargé en PDF`, 'success');
}

function exportReportsPDF() {
    const filtered = REPORTS_DATA.filter(r => {
        if (reportFilter.equipment !== 'all' && r.equipment !== reportFilter.equipment) return false;
        if (reportFilter.type !== 'all' && r.type !== reportFilter.type) return false;
        if (reportFilter.status !== 'all' && r.status !== reportFilter.status) return false;
        return true;
    });

    if (filtered.length === 0) {
        showNotification('Export impossible', 'Aucun rapport à exporter avec les filtres actuels', 'error');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('l'); // Landscape pour plus de colonnes

    // En-tête
    doc.setFillColor(102, 126, 234);
    doc.rect(0, 0, 297, 35, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text('RAPPORTS D\'INTERVENTION', 148.5, 22, { align: 'center' });
    
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const filterText = `Filtres: ${reportFilter.equipment !== 'all' ? reportFilter.equipment : 'Tous équip.'} | ${reportFilter.type !== 'all' ? reportFilter.type : 'Tous types'} | ${reportFilter.status !== 'all' ? reportFilter.status : 'Tous statuts'}`;
    doc.text(filterText, 148.5, 30, { align: 'center' });

    // Tableau avec autotable
    const statusColors = { validé: [39, 174, 96], en_attente: [243, 156, 18], rejeté: [231, 76, 60] };
    const statusLabels = { validé: 'Validé', en_attente: 'En attente', rejeté: 'Rejeté' };

    const tableData = filtered.map(r => [
        r.number,
        r.date,
        r.equipment,
        r.type,
        r.technician,
        r.duration,
        { content: statusLabels[r.status] || r.status, styles: { textColor: statusColors[r.status] || [100, 100, 100] } }
    ]);

    doc.autoTable({
        head: [['N°', 'Date', 'Équipement', 'Type', 'Technicien', 'Durée', 'Statut']],
        body: tableData,
        startY: 45,
        theme: 'striped',
        headStyles: {
            fillColor: [102, 126, 234],
            textColor: 255,
            fontStyle: 'bold'
        },
        alternateRowStyles: {
            fillColor: [248, 249, 250]
        },
        styles: {
            fontSize: 9,
            cellPadding: 3
        },
        columnStyles: {
            0: { cellWidth: 25 },
            1: { cellWidth: 25 },
            2: { cellWidth: 40 },
            3: { cellWidth: 30 },
            4: { cellWidth: 40 },
            5: { cellWidth: 20 },
            6: { cellWidth: 25 }
        }
    });

    // Pied de page
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(`Smart Maintenance | ${filtered.length} rapports exportés | Page ${i}/${pageCount}`, 148.5, 200, { align: 'center' });
        doc.text(`Généré le ${new Date().toLocaleString('fr-FR')}`, 148.5, 205, { align: 'center' });
    }

    // Télécharger
    const fileName = `rapports_maintenance_${new Date().toISOString().split('T')[0]}.pdf`;
    doc.save(fileName);

    showNotification('Export PDF', `${filtered.length} rapports exportés en PDF`, 'success');
}

// ==================== UTILISATEURS - TABLE ====================
function renderUsers() {
    const tbody = document.getElementById('usersTable');
    if (!tbody) return;

    if (USERS_DATA.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-slate-400">Aucun utilisateur</td></tr>`;
        return;
    }

    const roles = { superviseur: 'Superviseur', maintenance: 'Agent de maintenance', operateur: 'Opérateur' };

    tbody.innerHTML = USERS_DATA.map(user => {
        return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(user.first_name + ' ' + user.last_name)}&background=3b82f6&color=fff" class="w-8 h-8 rounded-full">
                        <div>
                            <p class="font-medium text-slate-800">${user.first_name} ${user.last_name}</p>
                            <p class="text-xs text-slate-500">${user.email}</p>
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4"><span class="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">${roles[user.role] || user.role}</span></td>
                <td class="px-6 py-4 text-slate-600">${user.department}</td>
                <td class="px-6 py-4 text-slate-500 text-sm">${user.last_login}</td>
                <td class="px-6 py-4">
                    <span class="flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full ${user.status === 'active' ? 'bg-green-500' : 'bg-slate-300'}"></span>
                        <span class="text-sm ${user.status === 'active' ? 'text-green-700' : 'text-slate-500'}">${user.status === 'active' ? 'Actif' : 'Inactif'}</span>
                    </span>
                </td>
                <td class="px-6 py-4">
                    <button onclick="editUser(${user.id})" class="text-blue-600 hover:text-blue-800 text-sm mr-3"><i class="fas fa-edit"></i></button>
                    <button onclick="toggleUserStatus(${user.id})" class="${user.status === 'active' ? 'text-amber-600 hover:text-amber-800' : 'text-green-600 hover:text-green-800'} text-sm mr-3"><i class="fas fa-${user.status === 'active' ? 'ban' : 'check'}"></i></button>
                    <button onclick="deleteUser(${user.id})" class="text-red-600 hover:text-red-800 text-sm"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}

function submitUser(e) {
    e.preventDefault();

    const username = document.getElementById('userUsername');
    const firstName = document.getElementById('userFirstName');
    const lastName = document.getElementById('userLastName');
    const email = document.getElementById('userEmail');
    const role = document.getElementById('userRole');
    const dept = document.getElementById('userDept');

    const newUser = {
        id: Date.now(),
        username: username.value,
        first_name: firstName.value,
        last_name: lastName.value,
        email: email.value,
        role: role.value,
        department: dept.value || 'Non assigné',
        last_login: 'Jamais',
        status: 'active'
    };

    USERS_DATA.push(newUser);
    showNotification('Utilisateur créé', `${newUser.first_name} ${newUser.last_name} a été ajouté avec succès.`, 'success');
    closeModal('newUserModal');
    document.getElementById('userForm').reset();
    renderUsers();
}

function editUser(id) {
    const user = USERS_DATA.find(u => u.id === id);
    if (!user) return;
    showNotification('Édition', `Modification de ${user.first_name} ${user.last_name} (fonctionnalité en développement)`, 'info');
}

function toggleUserStatus(id) {
    const user = USERS_DATA.find(u => u.id === id);
    if (!user) return;
    user.status = user.status === 'active' ? 'inactive' : 'active';
    showNotification('Statut modifié', `${user.first_name} ${user.last_name} est maintenant ${user.status === 'active' ? 'actif' : 'inactif'}.`, 'success');
    renderUsers();
}

function deleteUser(id) {
    const user = USERS_DATA.find(u => u.id === id);
    if (!user) return;
    if (!confirm(`Supprimer l'utilisateur ${user.first_name} ${user.last_name} ?`)) return;
    USERS_DATA = USERS_DATA.filter(u => u.id !== id);
    showNotification('Utilisateur supprimé', `${user.first_name} ${user.last_name} a été supprimé.`, 'success');
    renderUsers();
}

// ==================== SEUILS - CONFIGURATION ====================
function renderThresholds() {
    const container = document.getElementById('thresholdsContainer');
    if (!container) return;

    container.innerHTML = Object.entries(EQUIPMENTS_DATA).map(([equipKey, equip]) => {
        return `
            <div class="bg-white rounded-xl p-6 shadow-sm border border-slate-200">
                <div class="flex items-center gap-3 mb-4">
                    <div class="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                        <i class="fas fa-${equipKey === 'remplisseuse' ? 'fill-drip' : equipKey === 'compresseur' ? 'wind' : 'conveyor-belt'} text-blue-600"></i>
                    </div>
                    <div>
                        <h3 class="font-bold text-slate-800">${equip.name}</h3>
                        <p class="text-xs text-slate-500">${equip.station}</p>
                    </div>
                </div>
                <div class="space-y-4">
                    ${Object.entries(equip.sensors).map(([sensorKey, sensor]) => `
                        <div class="p-3 bg-slate-50 rounded-lg">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-sm font-medium text-slate-700 capitalize">${sensorKeyToLabel(sensorKey)}</span>
                                <span class="text-xs text-slate-500">Pin: ${sensor.pin}</span>
                            </div>
                            <div class="grid grid-cols-2 gap-3">
                                <div>
                                    <label class="text-xs text-slate-500 block mb-1">Seuil d'alerte</label>
                                    <input type="number" step="0.1" class="threshold-input w-full px-2 py-1.5 border border-slate-300 rounded text-sm" 
                                        data-equip="${equipKey}" data-sensor="${sensorKey}" data-type="threshold" 
                                        value="${sensor.threshold}" onchange="updateThreshold('${equipKey}', '${sensorKey}', 'threshold', this.value)">
                                </div>
                                <div>
                                    <label class="text-xs text-slate-500 block mb-1">Valeur critique</label>
                                    <input type="number" step="0.1" class="threshold-input w-full px-2 py-1.5 border border-slate-300 rounded text-sm" 
                                        data-equip="${equipKey}" data-sensor="${sensorKey}" data-type="critical" 
                                        value="${sensor.critical}" onchange="updateThreshold('${equipKey}', '${sensorKey}', 'critical', this.value)">
                                </div>
                            </div>
                            <div class="mt-2 flex items-center gap-2 text-xs">
                                <span class="text-slate-400">Actuel: ${sensor.value.toFixed(1)}${sensor.unit}</span>
                                <span class="px-1.5 py-0.5 rounded ${sensor.status === 'critical' ? 'bg-red-100 text-red-700' : sensor.status === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}">${sensor.status === 'normal' ? 'Normal' : sensor.status === 'warning' ? 'Attention' : 'Critique'}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function updateThreshold(equipKey, sensorKey, type, value) {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue <= 0) {
        showNotification('Erreur', 'Valeur invalide', 'error');
        return;
    }
    EQUIPMENTS_DATA[equipKey].sensors[sensorKey][type] = numValue;
}

function saveThresholds() {
    showNotification('Seuils enregistrés', 'Les modifications des seuils ont été sauvegardées.', 'success');
    updateRealtimeValues();
    updateSupervisionGauges();
}

// ==================== PARAMÈTRES SYSTÈME ====================
function renderSettings() {
    const systemInfo = document.getElementById('systemInfo');
    const esp32Config = document.getElementById('esp32Config');

    if (systemInfo) {
        systemInfo.innerHTML = `
            <div class="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                <span class="text-sm text-slate-600">Version système</span>
                <span class="text-sm font-mono font-medium text-slate-800">v2.4.0</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                <span class="text-sm text-slate-600">Dernière mise à jour</span>
                <span class="text-sm font-medium text-slate-800">19/05/2026</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                <span class="text-sm text-slate-600">Base de données</span>
                <span class="text-sm font-medium text-green-600">Connectée</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                <span class="text-sm text-slate-600">WebSocket</span>
                <span class="text-sm font-medium ${Object.keys(wsConnections).length > 0 ? 'text-green-600' : 'text-amber-600'}">${Object.keys(wsConnections).length > 0 ? 'Connecté' : 'Déconnecté'}</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                <span class="text-sm text-slate-600">Mode ESP32</span>
                <span class="text-sm font-medium ${isDemoMode ? 'text-purple-600' : 'text-green-600'}">${isDemoMode ? 'Simulation' : 'Réel'}</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                <span class="text-sm text-slate-600">Équipements surveillés</span>
                <span class="text-sm font-medium text-slate-800">3</span>
            </div>
        `;
    }

    if (esp32Config) {
        esp32Config.innerHTML = `
            <div class="space-y-3">
                <div>
                    <label class="text-xs text-slate-500 block mb-1">IP Remplisseuse</label>
                    <input type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value="${EQUIPMENTS_DATA.remplisseuse.esp32_ip || '192.168.1.101'}" id="esp32-ip-remplisseuse">
                </div>
                <div>
                    <label class="text-xs text-slate-500 block mb-1">IP Compresseur</label>
                    <input type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value="${EQUIPMENTS_DATA.compresseur.esp32_ip || '192.168.1.102'}" id="esp32-ip-compresseur">
                </div>
                <div>
                    <label class="text-xs text-slate-500 block mb-1">IP Convoyeur</label>
                    <input type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value="${EQUIPMENTS_DATA.convoyeur.esp32_ip || '192.168.1.103'}" id="esp32-ip-convoyeur">
                </div>
                <div>
                    <label class="text-xs text-slate-500 block mb-1">Port WebSocket</label>
                    <input type="number" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value="8080" id="esp32-port">
                </div>
                <div>
                    <label class="text-xs text-slate-500 block mb-1">Fréquence d'envoi (ms)</label>
                    <input type="number" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value="2000" id="esp32-frequency">
                </div>
            </div>
        `;
    }
}

function saveSettings() {
    const ips = ['remplisseuse', 'compresseur', 'convoyeur'];
    ips.forEach(equip => {
        const input = document.getElementById(`esp32-ip-${equip}`);
        if (input) EQUIPMENTS_DATA[equip].esp32_ip = input.value;
    });
    showNotification('Paramètres enregistrés', 'La configuration ESP32 a été mise à jour.', 'success');
}

function resetSettings() {
    if (!confirm('Réinitialiser tous les paramètres ?')) return;
    renderSettings();
    showNotification('Réinitialisation', 'Les paramètres par défaut ont été restaurés.', 'info');
}

function restartSystem() {
    if (!confirm('Redémarrer le système ? Cette action déconnectera tous les utilisateurs.')) return;
    showNotification('Redémarrage', 'Le système redémarre...', 'warning');
    setTimeout(() => {
        location.reload();
    }, 2000);
}

// ==================== HORLOGE ====================
function updateClock() {
    const now = new Date();
    const clockEl = document.getElementById('clock');
    const dateEl = document.getElementById('date');

    if (clockEl) clockEl.textContent = now.toLocaleTimeString('fr-FR', { hour12: false });
    if (dateEl) dateEl.textContent = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ==================== NOTIFICATIONS ====================
function showNotification(title, message, type = 'info') {
    const colors = {
        success: 'bg-green-500',
        error: 'bg-red-500',
        warning: 'bg-amber-500',
        info: 'bg-blue-500'
    };
    const icons = {
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle',
        info: 'info-circle'
    };

    const toast = document.createElement('div');
    toast.className = `fixed bottom-4 right-4 ${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg z-50 flex items-center gap-3 transform translate-y-20 opacity-0 transition-all duration-300 max-w-sm`;
    toast.innerHTML = `
        <i class="fas fa-${icons[type]}"></i>
        <div><p class="font-semibold text-sm">${title}</p><p class="text-xs opacity-90">${message}</p></div>
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.classList.remove('translate-y-20', 'opacity-0'), 100);
    setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}


// ==================== GRAPHIQUES ====================
let charts = {};

function initCharts() {
    const tempCtx = document.getElementById('tempChart');
    if (tempCtx) {
        if (charts.temp) charts.temp.destroy();
        charts.temp = new Chart(tempCtx, {
            type: 'line',
            data: {
                labels: ['00h','02h','04h','06h','08h','10h','12h','14h','16h','18h','20h','22h'],
                datasets: [
                    { label: 'Remplisseuse', data: [42,43,44,45,45,46,45,44,45,45,46,45], borderColor: '#3b82f6', tension: 0.4, fill: false },
                    { label: 'Compresseur',  data: [68,70,72,74,75,76,77,78,78,79,78,78], borderColor: '#f59e0b', tension: 0.4, fill: false },
                    { label: 'Convoyeur',    data: [35,36,36,37,37,37,38,37,37,36,36,37], borderColor: '#6366f1', tension: 0.4, fill: false }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
        });
    }

    const alarmCtx = document.getElementById('alarmChart');
    if (alarmCtx) {
        if (charts.alarm) charts.alarm.destroy();
        charts.alarm = new Chart(alarmCtx, {
            type: 'doughnut',
            data: {
                labels: ['Critiques', 'Avertissements', 'Résolues'],
                datasets: [{ data: [2, 1, 3], backgroundColor: ['#ef4444','#f59e0b','#22c55e'], borderWidth: 0 }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
        });
    }
}

function updateCharts() {
    // Mise à jour légère sans recréer les graphiques
    if (charts.temp && charts.temp.data && charts.temp.data.datasets) {
        const sensors = [
            EQUIPMENTS_DATA.remplisseuse?.sensors?.temperature,
            EQUIPMENTS_DATA.compresseur?.sensors?.temperature,
            EQUIPMENTS_DATA.convoyeur?.sensors?.temperature
        ];
        
        sensors.forEach((sensor, i) => {
            if (sensor && charts.temp.data.datasets[i] && charts.temp.data.datasets[i].data) {
                charts.temp.data.datasets[i].data.push(parseFloat(sensor.value.toFixed(1)));
                if (charts.temp.data.datasets[i].data.length > 12) {
                    charts.temp.data.datasets[i].data.shift();
                }
            }
        });
        charts.temp.update('none');
    }
}

function addToHistory() {
    // Placeholder pour historique
}

function updateDemoBadge() {
    const badge = document.getElementById('demoBadge');
    if (badge) {
        badge.classList.toggle('hidden', false);
        badge.innerHTML = isDemoMode ?
            '<i class="fas fa-microchip mr-1"></i> Mode Simulation' :
            '<i class="fas fa-wifi mr-1"></i> Mode ESP32 Réel';
    }
}


// ==================== BOUCLE TEMPS RÉEL ====================
function startRealtimeLoop() {
    console.log('Démarrage boucle temps réel...');

    realtimeInterval = setInterval(() => {
        // Vérifier si on doit repasser en mode démo
        if (!isDemoMode && ESP32_CONFIG.demoFallback) {
            const timeSinceLastData = Date.now() - lastRealDataTimestamp;
            if (timeSinceLastData > ESP32_CONFIG.fallbackTimeout) {
                isDemoMode = true;
                console.log('Retour mode démo (pas de données ESP32 depuis', ESP32_CONFIG.fallbackTimeout/1000, 's)');
                showNotification('Mode démo', 'Données ESP32 indisponibles - Mode simulation active', 'warning');
                updateDemoBadge();
            }
        }

        if (isDemoMode) {
            updateDemoValues();
        }

        updateRealtimeValues();
        updateCharts();
        updateWorkOrderTimers(); 
        updateAISensorStatus();
        aiProactiveCheck();
    }, 2000);
}

// ==================== TIMER OT EN TEMPS RÉEL ====================
function updateWorkOrderTimers() {
    WORK_ORDERS.filter(wo => wo.status === 'in_progress').forEach(wo => {
        const timerEl = document.getElementById(`wo-timer-${wo.id}`);
        if (timerEl && wo.startTime) {
            const elapsed = Math.floor((Date.now() - wo.startTime) / 1000);
            const hours = Math.floor(elapsed / 3600);
            const mins = Math.floor((elapsed % 3600) / 60);
            const secs = elapsed % 60;
            timerEl.textContent = `${hours}h ${mins}m ${secs}s`;
        }
    });
}

// Modifier startWorkOrder pour ajouter le timestamp
function startWorkOrder(woId) {
    const wo = WORK_ORDERS.find(w => w.id === woId);
    if (wo) { 
        wo.status = 'in_progress';
        wo.startTime = Date.now(); // AJOUTER CETTE LIGNE
    }
    showNotification('OT démarré', `Ordre de travail #${woId} est maintenant en cours.`, 'success');
    renderWorkOrdersList();
    updateWOCounts();
    updateKPIs();
}


// ==================== GESTION DES SECTIONS (COMPLÈTE) ====================
function showSection(sectionName) {
    const role = currentUser ? currentUser.role : 'superviseur';

    const sectionPermissions = {
        dashboard: ['superviseur', 'maintenance', 'operateur'],
        supervision: ['superviseur', 'maintenance', 'operateur'],
        alarms: ['superviseur', 'maintenance', 'operateur'],
        workorders: ['superviseur', 'maintenance'],
        planning: ['superviseur', 'maintenance'],
        reports: ['superviseur', 'maintenance'],
        users: ['superviseur'],
        thresholds: ['superviseur', 'maintenance'],
        aiassistant: ['superviseur', 'maintenance'],
        settings: ['superviseur']
    };

    const allowed = sectionPermissions[sectionName] || ['superviseur'];
    if (!allowed.includes(role)) {
        showNotification('Accès refusé', 'Vous n\'avez pas les droits nécessaires.', 'error');
        return;
    }

    // Cacher toutes les sections
    ['dashboard', 'supervision', 'alarms', 'workorders', 'planning', 'reports', 'users', 'thresholds', 'settings', 'aiassistant']
        .forEach(s => {
            const el = document.getElementById(s + 'Section');
            if (el) { el.classList.add('hidden'); el.classList.remove('fade-in'); }
        });

    // Afficher la section demandée
    const selected = document.getElementById(sectionName + 'Section');
    if (selected) {
        selected.classList.remove('hidden');
        void selected.offsetWidth;
        selected.classList.add('fade-in');
    }

    // Titres
    const titles = {
        dashboard: { title: 'Vue Générale Ligne', subtitle: 'Chaîne d\'embouteillage - Temps réel' },
        supervision: { title: 'Supervision Équipements', subtitle: 'Métriques temps réel par équipement' },
        alarms: { title: 'Gestion des Alarmes', subtitle: 'Alarmes actives et historique' },
        workorders: { title: 'Ordres de Travail', subtitle: 'GMAO - Suivi des interventions' },
        planning: { title: 'Planification Préventive', subtitle: 'Calendrier des maintenances' },
        reports: { title: 'Rapports d\'Intervention', subtitle: 'Historique et rapports' },
        users: { title: 'Gestion des Utilisateurs', subtitle: 'Administration des accès' },
        thresholds: { title: 'Configuration des Seuils', subtitle: 'Seuils d\'alerte par équipement' },
        aiassistant: { title: 'Assistant IA Maintenance', subtitle: 'Diagnostic intelligent et guidage pas à pas' },
        settings: { title: 'Paramètres Système', subtitle: 'Configuration générale' }
    };

    const t = titles[sectionName];
    if (t) {
        document.getElementById('pageTitle').textContent = t.title;
        document.getElementById('pageSubtitle').textContent = t.subtitle;
    }

    // Sidebar active
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active', 'text-white');
        item.classList.add('text-slate-300');
    });
    const activeBtn = document.querySelector(`button[onclick="showSection('${sectionName}')"]`);
    if (activeBtn) {
        activeBtn.classList.add('active', 'text-white');
        activeBtn.classList.remove('text-slate-300');
    }

    // Init spécifique par section
    if (sectionName === 'dashboard') {
        setTimeout(() => { initCharts(); updateCharts(); }, 100);
    }
    if (sectionName === 'supervision') {
        setTimeout(() => { initSupervisionCharts(); updateSupervisionGauges(); }, 100);
    }
    if (sectionName === 'alarms') { renderAlarmsList(); renderAlarmsHistory(); updateAlarmCounts(); }
    if (sectionName === 'workorders') { renderWorkOrdersList(); updateWOCounts(); populateAssigneeSelect(); }
    if (sectionName === 'planning') { renderPlanning(); }
    if (sectionName === 'reports') { renderReports(); }
    if (sectionName === 'users') { renderUsers(); }
    if (sectionName === 'thresholds') { renderThresholds(); }
    if (sectionName === 'aiassistant') { updateAISensorStatus(); }
    if (sectionName === 'settings') { renderSettings(); }
}

function renderPlanning() {
    renderPlanningCalendar();
    renderUpcomingMaintenance();
    renderMaintenanceFreq();
}

function populateAssigneeSelect() {
    const select = document.getElementById('woAssignee');
    if (!select) return;
    
    const maintainers = USERS_DATA.filter(u => u.role === 'maintenance');
    select.innerHTML = '<option value="">Non assigné</option>' + 
        maintainers.map(u => `<option value="${u.id}">${u.first_name} ${u.last_name}</option>`).join('');
}

function configureInterfaceByRole(role) {
    document.querySelectorAll('.sidebar-item[data-role]').forEach(item => {
        const allowed = item.getAttribute('data-role').split(',');
        item.style.display = (allowed.includes(role) || allowed.includes('all')) ? 'flex' : 'none';
    });

    // Masquer titres vides
    document.querySelectorAll('nav > div').forEach(section => {
        const siblings = [];
        let sibling = section.nextElementSibling;
        while (sibling && sibling.tagName === 'BUTTON') {
            siblings.push(sibling);
            sibling = sibling.nextElementSibling;
        }
        section.style.display = siblings.some(s => s.style.display !== 'none') ? 'block' : 'none';
    });

    // Bannière opérateur
    const readOnlyBanner = document.getElementById('readOnlyBanner');
    if (readOnlyBanner) readOnlyBanner.classList.toggle('hidden', role !== 'operateur');

    // Masquer boutons action pour opérateur
    if (role === 'operateur') {
        document.querySelectorAll('.create-ot-btn').forEach(btn => btn.style.display = 'none');
    }
}

// ==================== GESTION DU LOGIN ====================
async function handleLogin(e) {
    e.preventDefault();

    const usernameSelect = document.getElementById('userRoleSelect');
    const passwordInput = document.querySelector('input[type="password"]');

    if (!usernameSelect || !passwordInput) return;

    const username = usernameSelect.value;
    const password = passwordInput.value;

    const btn = document.querySelector('#loginForm button[type="submit"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Connexion...'; }

    try {
        await login(username, password);
        const loginScreen = document.getElementById('loginScreen');
        const appScreen = document.getElementById('app');

        if (loginScreen && appScreen) {
            loginScreen.classList.add('hidden');
            appScreen.classList.remove('hidden');
            await initApp();
        }
    } catch (error) {
        console.error('Login error:', error);
        let errorDiv = document.getElementById('loginError');
        if (!errorDiv) {
            errorDiv = document.createElement('div');
            errorDiv.id = 'loginError';
            errorDiv.className = 'mt-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm';
            document.getElementById('loginForm').appendChild(errorDiv);
        }
        errorDiv.textContent = error.message || 'Erreur de connexion';
        errorDiv.classList.remove('hidden');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Connexion'; }
    }
}

// ==================== INITIALISATION APPLICATION ====================
async function initApp() {
    try {
        // Initialiser les données de démo
        initDemoData();

        let userData;
        try {
            userData = await apiRequest('/users/me/');
        } catch (e) {
            userData = currentUser;
        }

        if (!userData && currentUser) userData = currentUser;
        if (!userData) { console.error('No user data'); return; }

        currentUser = userData;

        // UI Utilisateur
        const userNameEl = document.getElementById('userName');
        const userRoleEl = document.getElementById('userRoleDisplay');
        const userAvatarEl = document.getElementById('userAvatar');

        if (userNameEl) userNameEl.textContent = `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || userData.username;
        if (userRoleEl) {
            const roles = { superviseur: 'Superviseur', maintenance: 'Agent de maintenance', operateur: 'Opérateur' };
            userRoleEl.textContent = roles[userData.role] || userData.role;
        }
        if (userAvatarEl) {
            const name = `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || userData.username;
            userAvatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=3b82f6&color=fff`;
        }

        configureInterfaceByRole(userData.role);
        initCharts();
        startRealtimeLoop();

        updateClock();
        setInterval(updateClock, 1000);

        // WebSocket - Connexion temps réel
        connectWebSocket('/ws/dashboard/', handleDashboardMessage);

        // Mettre à jour le badge démo
        updateDemoBadge();

        // Section par défaut
        showSection('dashboard');

        showNotification('Connexion réussie', `Bienvenue ${userData.first_name || userData.username}`, 'success');

    } catch (error) {
        console.error('Init error:', error);
        showNotification('Erreur', 'Problème d\'initialisation', 'error');
    }
}

// ==================== EVENT LISTENERS ====================
document.addEventListener('DOMContentLoaded', () => {
    // Login form
    const loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', handleLogin);

    // Vérifier connexion existante
    const token = localStorage.getItem('access_token');
    const loginScreen = document.getElementById('loginScreen');
    const appScreen = document.getElementById('app');

    if (token && loginScreen && appScreen) {
        accessToken = token;
        loginScreen.classList.add('hidden');
        appScreen.classList.remove('hidden');
        initApp().catch(() => {
            localStorage.removeItem('access_token');
            if (loginScreen) loginScreen.classList.remove('hidden');
            if (appScreen) appScreen.classList.add('hidden');
        });
    }

    // Formulaire nouvel OT
        // Formulaire nouvel OT
    const newWOForm = document.getElementById('workOrderForm');
    if (newWOForm) {
        newWOForm.addEventListener('submit', submitWorkOrder);
    } else {
        console.warn('Formulaire workOrderForm non trouvé - event listener non attaché');
    }

    // Formulaiel nouvel utilisateur
    const newUserForm = document.getElementById('userForm');
    if (newUserForm) {
        newUserForm.addEventListener('submit', submitUser);
    }

        // Mise à jour dynamique des capteurs selon l'équipement choisi
    const alarmEquipSelect = document.getElementById('alarmEquipment');
    if (alarmEquipSelect) {
        alarmEquipSelect.addEventListener('change', updateAlarmSensors);
        // Initialiser au chargement
        updateAlarmSensors();
    }

        // Formulaire nouvelle alarme
    const alarmForm = document.getElementById('alarmForm');
    if (alarmForm) {
        alarmForm.addEventListener('submit', submitAlarm);
    }

       // Configuration IA - Charger depuis localStorage
    const savedAiConfig = localStorage.getItem('ai_config');
    if (savedAiConfig) {
        try {
            Object.assign(AI_CONFIG, JSON.parse(savedAiConfig));
        } catch(e) {
            console.warn('Config IA invalide:', e);
        }
    }
    
    // Charger la clé API
    loadAIApiKey();
    
    // Initialiser le mode IA dans le select
    const modeSelect = document.getElementById('aiPrimaryMode');
    if (modeSelect && AI_CONFIG.mode) {
        modeSelect.value = AI_CONFIG.mode;
    }
    
    // Initialiser le badge mode
    const modeBtn = document.getElementById('aiModeBtn');
    if (modeBtn) {
        const labels = { local: 'Mode: Local', hybrid: 'Mode: Hybride', api: 'Mode: API' };
        modeBtn.innerHTML = `<i class="fas fa-brain mr-1"></i>${labels[AI_CONFIG.mode] || 'Mode: Local'}`;
    }
});

// ==================== EXPORTS GLOBAUX ====================
window.showSection = showSection;
window.logout = logout;
window.showModal = showModal;
window.closeModal = closeModal;
window.showEquipmentDetail = showEquipmentDetail;
window.acknowledgeAlarm = acknowledgeAlarm;
window.triggerWorkOrder = triggerWorkOrder;
window.startWorkOrder = startWorkOrder;
window.completeWorkOrder = completeWorkOrder;
window.createOTFromEquipment = createOTFromEquipment;
window.viewHistory = viewHistory;
window.filterAlarms = filterAlarms;
window.filterWorkOrders = filterWorkOrders;
window.submitWorkOrder = submitWorkOrder;
window.submitUser = submitUser;
window.saveThresholds = saveThresholds;
window.saveSettings = saveSettings;
window.resetSettings = resetSettings;
window.restartSystem = restartSystem;
window.exportReportsPDF = exportReportsPDF;
window.toggleDemoMode = toggleDemoMode;
window.editUser = editUser;
window.toggleUserStatus = toggleUserStatus;
window.deleteUser = deleteUser;
window.viewReport = viewReport;
window.downloadReport = downloadReport;
window.viewWorkOrderDetails = viewWorkOrderDetails;
window.updateThreshold = updateThreshold;
window.showDayDetails = showDayDetails;
window.showMaintenanceDetail = showMaintenanceDetail;
window.previousMonth = previousMonth;
window.nextMonth = nextMonth;
window.goToToday = goToToday;
window.submitAlarm = submitAlarm;
window.updateAlarmSensors = updateAlarmSensors;
window.createOTFromMaintenance = createOTFromMaintenance;
window.updateReportFilter = updateReportFilter;
window.editReportStatus = editReportStatus;
window.updateWorkOrderTimers = updateWorkOrderTimers;
window.initWorkOrderDateConstraints = initWorkOrderDateConstraints;

// ==================== IA ASSISTANT MAINTENANCE ====================

// Configuration IA
const AI_CONFIG = {
    mode: 'hybrid', // 'local', 'api', 'hybrid'
    proactive: true,
    autoOT: true,
    confidenceThreshold: 0.8,
    externalAPI: 'openrouter',
    apiKey: '',
    chatHistory: [],
    maxHistory: 50
};

// Base de connaissances locale (règles métier basées sur ton PDF)
const AI_KNOWLEDGE_BASE = {
    compresseur: {
        sensors: ['temperature', 'pressure', 'vibration', 'current'],
        diagnostics: {
            temperature: {
                critical: {
                    threshold: 85,
                    label: 'Surchauffe persistante',
                    probableCauses: ['Manque de ventilation', 'Manque d\'huile', 'Filtre encrassé'],
                    actionIA: 'Alerter, proposer arrêt contrôlé',
                    steps: [
                        'Arrêter le compresseur',
                        'Laisser refroidir',
                        'Vérifier l\'huile',
                        'Contrôler le filtre',
                        'Vérifier la ventilation',
                        'Relancer en test'
                    ]
                },
                warning: {
                    threshold: 70,
                    label: 'Température élevée',
                    probableCauses: ['Ventilation réduite', 'Huile vieillissante'],
                    actionIA: 'Surveillance renforcée',
                    steps: [
                        'Vérifier la ventilation',
                        'Contrôler le niveau d\'huile',
                        'Planifier maintenance préventive'
                    ]
                }
            },
            pressure: {
                critical: {
                    threshold: 9.0,
                    label: 'Pression excessive',
                    probableCauses: ['Soupape bloquée', 'Fuite interne'],
                    actionIA: 'Arrêt d\'urgence recommandé',
                    steps: [
                        'Arrêter immédiatement',
                        'Vérifier la soupape de sécurité',
                        'Contrôler les fuites internes',
                        'Ne pas redémarrer sans inspection'
                    ]
                },
                warning: {
                    threshold: 7.5,
                    label: 'Pression instable',
                    probableCauses: ['Fuite', 'Soupape défectueuse', 'Filtre colmaté'],
                    actionIA: 'Déclencher maintenance prioritaire',
                    steps: [
                        'Vérifier les fuites',
                        'Contrôler le filtre',
                        'Tester la soupape',
                        'Vérifier le pressostat',
                        'Remettre en service'
                    ]
                }
            },
            vibration: {
                critical: {
                    threshold: 6.0,
                    label: 'Vibration forte continue',
                    probableCauses: ['Roulement usé', 'Désalignement', 'Fixation desserrée'],
                    actionIA: 'Proposer contrôle mécanique',
                    steps: [
                        'Isoler l\'équipement',
                        'Contrôler les fixations',
                        'Vérifier l\'alignement',
                        'Inspecter les roulements',
                        'Remplacer si besoin'
                    ]
                },
                warning: {
                    threshold: 4.5,
                    label: 'Vibration anormale',
                    probableCauses: ['Désalignement léger', 'Fixation desserrée'],
                    actionIA: 'Planifier inspection',
                    steps: [
                        'Contrôler les fixations',
                        'Vérifier l\'alignement',
                        'Planifier remplacement roulements'
                    ]
                }
            },
            current: {
                critical: {
                    threshold: 18.0,
                    label: 'Surcharge importante',
                    probableCauses: ['Frottement', 'Défaut moteur', 'Compression anormale'],
                    actionIA: 'Déclencher diagnostic électrique et mécanique',
                    steps: [
                        'Couper l\'alimentation',
                        'Vérifier le moteur',
                        'Contrôler les câbles',
                        'Examiner la charge mécanique',
                        'Corriger avant redémarrage'
                    ]
                },
                warning: {
                    threshold: 15.0,
                    label: 'Courant élevé',
                    probableCauses: ['Charge mécanique accrue', 'Défaut partiel moteur'],
                    actionIA: 'Surveillance électrique',
                    steps: [
                        'Contrôler la charge mécanique',
                        'Vérifier le moteur',
                        'Planifier diagnostic électrique'
                    ]
                }
            }
        }
    },
    remplisseuse: {
        sensors: ['niveau', 'pressure', 'vitesse', 'current'],
        diagnostics: {
            niveau: {
                critical: {
                    threshold: null, // Hors tolérance
                    label: 'Niveau hors tolérance',
                    probableCauses: ['Capteur mal calibré', 'Buse encrassée'],
                    actionIA: 'Recalibrer et contrôler',
                    steps: [
                        'Arrêter la ligne',
                        'Vérifier le capteur de niveau',
                        'Nettoyer les buses',
                        'Recalibrer',
                        'Tester sur plusieurs bouteilles'
                    ]
                }
            },
            pressure: {
                critical: {
                    threshold: null,
                    label: 'Instabilité continue',
                    probableCauses: ['Défaut d\'alimentation pneumatique', 'Valve défectueuse', 'Fuite'],
                    actionIA: 'Proposer inspection du circuit',
                    steps: [
                        'Contrôler les connexions pneumatiques',
                        'Vérifier les fuites',
                        'Tester les valves',
                        'Relancer en mode test'
                    ]
                }
            },
            vitesse: {
                critical: {
                    threshold: null,
                    label: 'Arrêt ou blocage',
                    probableCauses: ['Moteur défectueux', 'Synchronisation perdue', 'Encrassement mécanique'],
                    actionIA: 'Générer alerte de cadence',
                    steps: [
                        'Vérifier le moteur',
                        'Contrôler la synchronisation',
                        'Examiner les pièces mobiles',
                        'Nettoyer et relancer'
                    ]
                }
            },
            current: {
                critical: {
                    threshold: null,
                    label: 'Surcharge critique',
                    probableCauses: ['Frottement', 'Blocage', 'Moteur sollicité'],
                    actionIA: 'Déclencher arrêt préventif',
                    steps: [
                        'Couper la machine',
                        'Vérifier le blocage',
                        'Contrôler le moteur',
                        'Inspecter les organes mécaniques'
                    ]
                }
            }
        }
    },
    convoyeur: {
        sensors: ['vitesse', 'vibration', 'temperature'],
        diagnostics: {
            vitesse: {
                critical: {
                    threshold: 1.8,
                    label: 'Glissement ou arrêt',
                    probableCauses: ['Bande détendue', 'Moteur faible', 'Réducteur usé'],
                    actionIA: 'Alerter et diagnostiquer',
                    steps: [
                        'Arrêter le convoyeur',
                        'Vérifier la bande',
                        'Contrôler moteur et réducteur',
                        'Relancer en test'
                    ]
                },
                warning: {
                    threshold: 1.5,
                    label: 'Écart de cadence',
                    probableCauses: ['Bande légèrement détendue', 'Charge excessive'],
                    actionIA: 'Surveillance mécanique',
                    steps: [
                        'Vérifier la tension de la bande',
                        'Contrôler la charge',
                        'Planifier inspection'
                    ]
                }
            },
            vibration: {
                critical: {
                    threshold: 4.5,
                    label: 'Vibration forte continue',
                    probableCauses: ['Roulement usé', 'Galet défectueux', 'Désalignement'],
                    actionIA: 'Déclencher maintenance conditionnelle',
                    steps: [
                        'Isoler le convoyeur',
                        'Vérifier les galets',
                        'Inspecter les roulements',
                        'Corriger l\'alignement'
                    ]
                },
                warning: {
                    threshold: 3.0,
                    label: 'Augmentation progressive',
                    probableCauses: ['Roulement vieillissant', 'Galet usé'],
                    actionIA: 'Planifier remplacement',
                    steps: [
                        'Inspecter les galets',
                        'Vérifier les roulements',
                        'Planifier remplacement'
                    ]
                }
            },
            temperature: {
                critical: {
                    threshold: null,
                    label: 'Surchauffe',
                    probableCauses: ['Mauvaise lubrification', 'Surcharge', 'Frottement'],
                    actionIA: 'Déclencher alerte thermique',
                    steps: [
                        'Arrêter le système',
                        'Laisser refroidir',
                        'Contrôler la lubrification',
                        'Tester à vide'
                    ]
                }
            }
        }
    }
};

// ==================== IA LOCALE - DIAGNOSTIC ====================
function aiLocalDiagnose(equipmentKey, sensorKey, value) {
    const equip = AI_KNOWLEDGE_BASE[equipmentKey];
    if (!equip) return null;
    
    const sensorDiag = equip.diagnostics[sensorKey];
    if (!sensorDiag) return null;
    
    const equipData = EQUIPMENTS_DATA[equipmentKey];
    const sensorData = equipData ? equipData.sensors[sensorKey] : null;
    
    if (!sensorData) return null;
    
    // Déterminer le niveau de sévérité
    let severity = 'normal';
    let diagnostic = null;
    
    if (sensorData.critical && value >= sensorData.critical) {
        severity = 'critical';
        diagnostic = sensorDiag.critical;
    } else if (sensorData.threshold && value >= sensorData.threshold) {
        severity = 'warning';
        diagnostic = sensorDiag.warning || sensorDiag.critical;
    }
    
    if (!diagnostic) return null;
    
    return {
        equipment: EQUIPMENTS_DATA[equipmentKey]?.name || equipmentKey,
        sensor: sensorKey,
        value: value,
        unit: sensorData.unit,
        severity: severity,
        threshold: sensorData.threshold,
        critical: sensorData.critical,
        label: diagnostic.label,
        probableCauses: diagnostic.probableCauses,
        actionIA: diagnostic.actionIA,
        steps: diagnostic.steps,
        pin: sensorData.pin
    };
}

// ==================== IA LOCALE - DIAGNOSTIC COMPLET ====================
function aiLocalFullDiagnose() {
    const results = [];
    
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const equip = EQUIPMENTS_DATA[equipKey];
        Object.keys(equip.sensors).forEach(sensorKey => {
            const sensor = equip.sensors[sensorKey];
            if (sensor.status !== 'normal') {
                const diag = aiLocalDiagnose(equipKey, sensorKey, sensor.value);
                if (diag) results.push(diag);
            }
        });
    });
    
    return results.sort((a, b) => {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
    });
}

// ==================== IA API EXTERNE (AVEC FALLBACK MULTI-MODÈLES) ====================

function getApiKey() {
    // Priorité: input field > AI_CONFIG > localStorage
    const input = document.getElementById('aiApiKey');
    const fromInput = input ? input.value.trim() : '';
    const fromConfig = AI_CONFIG.apiKey || '';
    const fromStorage = localStorage.getItem('ai_api_key') || '';
    
    return fromInput || fromConfig || fromStorage || '';
}

async function aiAPIQuery(message, context = {}) {
    const apiKey = getApiKey();
    
    console.log('=== AI API CALL ===');
    console.log('Clé API présente:', apiKey ? 'OUI (' + apiKey.substring(0, 8) + '...)' : 'NON');
    console.log('Message:', message.substring(0, 100) + '...');
    
    if (!apiKey || apiKey.length < 10) {
        console.error('IA API: Clé API manquante ou invalide');
        return { error: 'Clé API OpenRouter manquante. Allez dans Configuration IA et entrez votre clé.', fallback: true };
    }
    
    // Construction du prompt avec contexte
    const systemPrompt = `Tu es un expert en maintenance industrielle pour une chaîne d'embouteillage. 
Tu analyses les données de capteurs (température, pression, vibration, courant) des équipements : compresseur d'air, remplisseuse, convoyeur.
Tu dois donner des diagnostics précis, des étapes de maintenance concrètes, et proposer des actions.
Sois concis, technique, et en français. Réponds en maximum 300 mots.`;
    
    const equipmentContext = Object.entries(EQUIPMENTS_DATA).map(([key, equip]) => {
        const sensors = Object.entries(equip.sensors).map(([sKey, s]) => {
            return `${sKey}: ${s.value.toFixed(1)}${s.unit} (seuil: ${s.threshold}, critique: ${s.critical}, statut: ${s.status})`;
        }).join(', ');
        return `${equip.name}: ${sensors}`;
    }).join('\n');
    
    const fullPrompt = `${systemPrompt}\n\nÉtat actuel des équipements:\n${equipmentContext}\n\nQuestion: ${message}`;
    
    // Liste des modèles gratuits à essayer (ordre de préférence - mis à jour juin 2026)
    const freeModels = [
         'meta-llama/llama-3.3-70b-instruct:free',
         'meta-llama/llama-3.2-3b-instruct:free',
         'qwen/qwen3-next-80b-a3b-instruct:free',
         'qwen/qwen3-coder:free',
         'openai/gpt-oss-20b:free',
         'openai/gpt-oss-120b:free',
         'google/gemma-4-31b-it:free',
         'liquid/lfm-2.5-1.2b-instruct:free',
         'nousresearch/hermes-3-llama-3.1-405b:free'
    ];
    
    for (const model of freeModels) {
        console.log(`Essai modèle: ${model}...`);
        
        try {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': window.location.origin || 'http://localhost',
                    'X-Title': 'Smart Maintenance System'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: fullPrompt }
                    ],
                    max_tokens: 800,
                    temperature: 0.7
                })
            });
            
            console.log(`Réponse ${model}:`, response.status);
            
            if (!response.ok) {
                let errorText = '';
                try {
                    const errData = await response.json();
                    errorText = errData.error?.message || JSON.stringify(errData);
                } catch {
                    errorText = await response.text();
                }
                console.warn(`Modèle ${model} échoué:`, response.status, errorText);
                continue;
            }
            
            const data = await response.json();
            
            if (data.error) {
                console.warn(`Modèle ${model} erreur API:`, data.error);
                continue;
            }
            
            const content = data.choices?.[0]?.message?.content;
            if (!content || content.trim().length === 0) {
                console.warn(`Modèle ${model} réponse vide`);
                continue;
            }
            
            console.log(`✅ Modèle ${model} fonctionne !`);
            return { 
                response: content.trim(),
                model: model,
                usage: data.usage || {}
            };
            
        } catch (error) {
            console.warn(`Modèle ${model} exception:`, error.message);
            continue;
        }
    }
    
    // Aucun modèle n'a fonctionné
    console.error('Tous les modèles gratuits ont échoué');
    return { 
        error: 'Aucun modèle IA gratuit disponible actuellement. Vérifiez votre clé API ou réessayez plus tard.',
        fallback: true 
    };
}

// ==================== ROUTEUR IA (CORRIGÉ) ====================
async function aiRouter(query, type = 'chat') {
    const mode = document.getElementById('aiPrimaryMode')?.value || AI_CONFIG.mode;
    const apiKey = document.getElementById('aiApiKey')?.value?.trim() || AI_CONFIG.apiKey;
    
    // 🔴 CORRECTION 1 : Vérifier si une clé API est présente AVANT tout
    const hasApiKey = apiKey && apiKey.length > 10;
    
    // Mode Local uniquement
    if (mode === 'local' || !hasApiKey) {
        if (!hasApiKey && mode !== 'local') {
            console.log('IA: Pas de clé API, fallback sur Local');
        }
        return aiLocalProcess(query, type);
    }
    
    // Mode API uniquement
    if (mode === 'api') {
        if (!hasApiKey) {
            return { error: 'Clé API requise pour le mode API. Entrez votre clé OpenRouter.', fallback: true };
        }
        return await aiAPIQuery(query);
    }
    
    // Mode Hybride : API pour les conversations, Local pour les diagnostics rapides
    if (mode === 'hybrid') {
        // Si c'est un diagnostic automatique (proactif) → Local (rapide)
        if (type === 'diagnostic') {
            return aiLocalProcess(query, type);
        }
        
        // Si c'est une question utilisateur → API (intelligent)
        // 🔴 CORRECTION 2 : Appeler l'API pour TOUTES les questions utilisateur, pas seulement les longues
        if (type === 'chat') {
            console.log('IA Hybride: Appel API pour question utilisateur');
            const apiResult = await aiAPIQuery(query);
            if (apiResult.error) {
                console.log('IA: Erreur API, fallback Local:', apiResult.error);
                return aiLocalProcess(query, type);
            }
            return apiResult;
        }
    }
    
    // Par défaut
    return aiLocalProcess(query, type);
}

// ==================== TRAITEMENT LOCAL ====================
function aiLocalProcess(query, type) {
    if (type === 'diagnostic') {
        return aiLocalFullDiagnose();
    }
    
    // Analyse du texte de l'utilisateur
    const lowerQuery = query.toLowerCase();
    
    // Détection d'équipement
    let targetEquip = null;
    if (lowerQuery.includes('compresseur')) targetEquip = 'compresseur';
    else if (lowerQuery.includes('remplisseuse')) targetEquip = 'remplisseuse';
    else if (lowerQuery.includes('convoyeur')) targetEquip = 'convoyeur';
    
        // Détection d'action par mots-clés dans la question
    if (lowerQuery.includes('diagnostic') || lowerQuery.includes('analyser') || lowerQuery.includes('problème') || lowerQuery.includes('surchauffe') || lowerQuery.includes('chauffe') || lowerQuery.includes('température') || lowerQuery.includes('pression') || lowerQuery.includes('vibration')) {
        if (targetEquip) {
            const equip = EQUIPMENTS_DATA[targetEquip];
            const issues = [];
            Object.keys(equip.sensors).forEach(sensorKey => {
                const sensor = equip.sensors[sensorKey];
                if (sensor.status !== 'normal') {
                    const diag = aiLocalDiagnose(targetEquip, sensorKey, sensor.value);
                    if (diag) issues.push(diag);
                }
            });
            // Si pas d'issue active, faire un diagnostic général
            if (issues.length === 0) {
                Object.keys(equip.sensors).forEach(sensorKey => {
                    const diag = aiLocalDiagnose(targetEquip, sensorKey, equip.sensors[sensorKey].value);
                    if (diag) issues.push(diag);
                });
            }
            return { type: 'diagnostic', equipment: targetEquip, issues: issues };
        } else {
            return { type: 'diagnostic', issues: aiLocalFullDiagnose() };
        }
    }
    
    if (lowerQuery.includes('checklist') || lowerQuery.includes('étape') || lowerQuery.includes('comment') || lowerQuery.includes('comment faire') || lowerQuery.includes('procédure')) {
        const diag = aiLocalFullDiagnose()[0];
        if (diag) {
            return { type: 'checklist', diagnostic: diag };
        }
    }
    
    // Réponse par défaut améliorée avec contexte
    const equipStatus = Object.entries(EQUIPMENTS_DATA).map(([key, equip]) => {
        const hasIssue = Object.values(equip.sensors).some(s => s.status !== 'normal');
        return `• ${equip.name}: ${hasIssue ? '⚠️ Problème détecté' : '✅ Normal'}`;
    }).join('\n');
    
    return { 
        type: 'info', 
        message: `📋 **État actuel des équipements :**\n${equipStatus}\n\nJe peux vous aider avec :\n• **Diagnostic complet** - tapez "diagnostic"\n• **Checklist de maintenance** - tapez "checklist"\n• **Création d'ordres de travail** - tapez "créer OT"\n• **Analyse prédictive** - tapez "prédiction"\n\nDécrivez votre problème ou demandez un diagnostic.` 
    };
}

// ==================== INTERFACE CHAT (CORRIGÉ) ====================
function sendAIMessage() {
    const input = document.getElementById('aiChatInput');
    const message = input.value.trim();
    if (!message) return;
    
    // Ajouter message utilisateur
    addChatMessage('user', message);
    input.value = '';
    
    // Afficher typing
    showTypingIndicator();
    
        // Traiter la requête
    setTimeout(async () => {
        removeTypingIndicator();
        
        console.log('=== SEND AI MESSAGE ===');
        console.log('Message:', message);
        
        const result = await aiRouter(message, 'chat');
        
        console.log('Résultat router:', result);
        
        if (result.error) {
            // Erreur API sans fallback possible
            addChatMessage('ai', `⚠️ **API non disponible**\n\n${result.error}\n\nJe bascule sur l'IA Locale...`, 'error');
            
            // Forcer le fallback local
            const localResult = aiLocalProcess(message, 'chat');
            processAIResponse(localResult);
            
        } else if (result.apiError) {
            // API a échoué mais on a un fallback local
            addChatMessage('ai', `⚠️ API temporairement indisponible (${result.apiError})\n\nRéponse de l'IA locale :`, 'warning');
            processAIResponse(result);
            
        } else if (result.response) {
            // Réponse de l'API
            addChatMessage('ai', result.response);
            
        } else {
            // Réponse locale
            processAIResponse(result);
        }
    }, 500);
}

function addChatMessage(sender, text, type = 'normal') {
    const container = document.getElementById('aiChatMessages');
    const div = document.createElement('div');
    div.className = 'ai-message flex gap-3';
    
    if (sender === 'user') {
        div.innerHTML = `
            <div class="flex-1"></div>
            <div class="bg-blue-600 text-white rounded-lg p-3 max-w-[80%] text-sm">
                ${text}
            </div>
            <div class="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <i class="fas fa-user text-blue-600 text-sm"></i>
            </div>
        `;
    } else {
        const bgColor = type === 'error' ? 'bg-red-50 border border-red-200' : 'bg-purple-50';
        div.innerHTML = `
            <div class="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0">
                <i class="fas fa-robot text-purple-600 text-sm"></i>
            </div>
            <div class="${bgColor} rounded-lg p-3 max-w-[80%] text-sm text-slate-700 whitespace-pre-line">
                ${formatMarkdown(text)}
            </div>
        `;
    }
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    // Sauvegarder dans l'historique
    AI_CONFIG.chatHistory.push({ sender, text, time: Date.now() });
    if (AI_CONFIG.chatHistory.length > AI_CONFIG.maxHistory) {
        AI_CONFIG.chatHistory.shift();
    }
}

function formatMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^#{1,3} (.+)$/gm, '<strong class="text-base">$1</strong>')
        .replace(/\|(.+)\|/g, (match) => {
            const cells = match.split('|').filter(c => c.trim() && !c.match(/^[-\s]+$/));
            return '<div class="flex gap-2 flex-wrap">' + cells.map(c => 
                `<span class="bg-white border border-slate-200 px-2 py-0.5 rounded text-xs">${c.trim()}</span>`
            ).join('') + '</div>';
        })
        .replace(/^[-•] (.+)$/gm, '<div class="flex gap-2">• <span>$1</span></div>')
        .replace(/\n/g, '<br>');
}

function showTypingIndicator() {
    const container = document.getElementById('aiChatMessages');
    const div = document.createElement('div');
    div.id = 'aiTyping';
    div.className = 'ai-message flex gap-3';
    div.innerHTML = `
        <div class="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0">
            <i class="fas fa-robot text-purple-600 text-sm"></i>
        </div>
        <div class="bg-purple-50 rounded-lg p-3">
            <div class="ai-typing">
                <div class="dot"></div>
                <div class="dot"></div>
                <div class="dot"></div>
            </div>
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
    const typing = document.getElementById('aiTyping');
    if (typing) typing.remove();
}

function clearChat() {
    const container = document.getElementById('aiChatMessages');
    container.innerHTML = '';
    AI_CONFIG.chatHistory = [];
    addChatMessage('ai', 'Conversation effacée. Comment puis-je vous aider ?');
}

function quickAsk(type) {
    const input = document.getElementById('aiChatInput');
    const queries = {
        diagnostic: 'Faire un diagnostic complet de tous les équipements',
        compresseur: 'Diagnostic du compresseur d\'air',
        remplisseuse: 'Diagnostic de la remplisseuse',
        convoyeur: 'Diagnostic du convoyeur'
    };
    input.value = queries[type] || '';
    sendAIMessage();
}

// ==================== TRAITER LA RÉPONSE IA ====================
function processAIResponse(result) {
    if (!result) {
        addChatMessage('ai', '❌ Erreur: réponse invalide de l\'IA.');
        return;
    }
    
    if (result.type === 'diagnostic') {
        if (result.issues && result.issues.length > 0) {
            let text = `🔍 **Diagnostic complet**\n\n`;
            result.issues.forEach((issue, i) => {
                const emoji = issue.severity === 'critical' ? '🔴' : '🟡';
                text += `${emoji} **${issue.equipment}** - ${issue.label}\n`;
                text += `   Valeur: ${issue.value.toFixed(1)}${issue.unit} (Seuil: ${issue.threshold}${issue.unit})\n`;
                text += `   Causes probables: ${issue.probableCauses.join(', ')}\n`;
                text += `   Action: ${issue.actionIA}\n\n`;
            });
            addChatMessage('ai', text);
            
            // Afficher le diagnostic actif
            showActiveDiagnostic(result.issues[0]);
        } else {
            addChatMessage('ai', '✅ Tous les équipements fonctionnent normalement. Aucun problème détecté.');
        }
    } else if (result.type === 'checklist') {
        showChecklist(result.diagnostic);
    } else if (result.type === 'info') {
        addChatMessage('ai', result.message || 'Comment puis-je vous aider ?');
    } else {
        // Fallback pour tout autre type
        addChatMessage('ai', result.message || result.response || JSON.stringify(result));
    }
}

// ==================== AFFICHER CHECKLIST INTERACTIVE ====================
function showChecklist(diagnostic) {
    const container = document.getElementById('activeDiagnostic');
    const content = document.getElementById('diagnosticContent');
    const equipLabel = document.getElementById('diagnosticEquip');
    
    container.classList.remove('hidden');
    equipLabel.textContent = diagnostic.equipment;
    
    const severityClass = diagnostic.severity === 'critical' ? 'critical' : 'warning';
    const severityText = diagnostic.severity === 'critical' ? 'CRITIQUE' : 'ATTENTION';
    
    let html = `
        <div class="diagnostic-card ${severityClass} bg-white rounded-lg p-4 mb-4">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <h5 class="font-bold text-slate-800">${diagnostic.label}</h5>
                    <p class="text-sm text-slate-500">${diagnostic.sensor} - ${diagnostic.value.toFixed(1)}${diagnostic.unit}</p>
                </div>
                <span class="severity-indicator ${severityClass}">
                    <span class="w-2 h-2 rounded-full ${diagnostic.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'} pulse-dot"></span>
                    ${severityText}
                </span>
            </div>
            <div class="mb-3">
                <p class="text-sm font-medium text-slate-700">Causes probables:</p>
                <div class="flex flex-wrap gap-2 mt-1">
                    ${diagnostic.probableCauses.map(c => `<span class="px-2 py-1 bg-slate-100 text-slate-600 rounded text-xs">${c}</span>`).join('')}
                </div>
            </div>
            <div class="mb-3">
                <p class="text-sm font-medium text-slate-700">Action recommandée:</p>
                <p class="text-sm text-purple-700 bg-purple-50 p-2 rounded mt-1">${diagnostic.actionIA}</p>
            </div>
        </div>
        
        <div class="bg-white rounded-lg p-4 border border-slate-200">
            <h5 class="font-bold text-slate-800 mb-3 flex items-center gap-2">
                <i class="fas fa-tasks text-purple-600"></i>
                Checklist d'intervention
                <span class="text-xs text-slate-400 font-normal ml-auto" id="checklistProgress">0/${diagnostic.steps.length}</span>
            </h5>
            <div class="space-y-2" id="checklistItems">
                ${diagnostic.steps.map((step, i) => `
                    <div class="checklist-item flex items-center gap-3 p-3 rounded-lg cursor-pointer" onclick="toggleChecklistItem(this, ${i})">
                        <div class="check-circle flex-shrink-0">
                            <i class="fas fa-check"></i>
                        </div>
                        <span class="text-sm text-slate-700 flex-1">${i + 1}. ${step}</span>
                    </div>
                `).join('')}
            </div>
            <div class="mt-4 flex gap-2">
                <button onclick="aiCreateWorkOrderFromDiagnostic()" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                    <i class="fas fa-clipboard-list mr-2"></i>Créer un OT
                </button>
                <button onclick="document.getElementById('activeDiagnostic').classList.add('hidden')" class="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm hover:bg-slate-50">
                    Fermer
                </button>
            </div>
        </div>
    `;
    
    content.innerHTML = html;
}

function toggleChecklistItem(el, index) {
    el.classList.toggle('completed');
    const items = document.querySelectorAll('.checklist-item');
    const completed = document.querySelectorAll('.checklist-item.completed');
    const progress = document.getElementById('checklistProgress');
    if (progress) {
        progress.textContent = `${completed.length}/${items.length}`;
    }
    
    // Si tout complété, notification
    if (completed.length === items.length) {
        showNotification('Checklist terminée', 'Toutes les étapes sont complétées !', 'success');
    }
}

function showActiveDiagnostic(diagnostic) {
    showChecklist(diagnostic);
}

// ==================== ACTIONS RAPIDES IA ====================
function aiCreateWorkOrder() {
    const diag = aiLocalFullDiagnose()[0];
    if (!diag) {
        showNotification('Info', 'Aucun problème détecté. Pas besoin d\'OT.', 'info');
        return;
    }
    aiCreateWorkOrderFromDiagnostic(diag);
}

function aiCreateWorkOrderFromDiagnostic(diagnostic) {
    const equipMap = { 'Remplisseuse': '1', "Compresseur d'air": '2', 'Convoyeur': '3' };
    const equipKey = Object.keys(EQUIPMENTS_DATA).find(k => EQUIPMENTS_DATA[k].name === diagnostic.equipment);
    
    const newWO = {
        id: Date.now(),
        number: `OT-${WORK_ORDERS.length + 24}`,
        title: `IA: ${diagnostic.label}`,
        type: diagnostic.severity === 'critical' ? 'Corrective' : 'Préventive',
        status: 'planned',
        priority: diagnostic.severity === 'critical' ? 'urgent' : 'high',
        assigned: 'Non assigné',
        deadline: new Date(Date.now() + (diagnostic.severity === 'critical' ? 1 : 3) * 24 * 60 * 60 * 1000).toLocaleDateString('fr-FR'),
        description: `OT généré par l'IA Assistant:\n${diagnostic.label}\nValeur: ${diagnostic.value.toFixed(1)}${diagnostic.unit}\nCauses: ${diagnostic.probableCauses.join(', ')}\n\nChecklist:\n${diagnostic.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
        equipment: diagnostic.equipment,
        created: new Date().toLocaleDateString('fr-FR'),
        duration: diagnostic.severity === 'critical' ? '4h00' : '2h00'
    };
    
    WORK_ORDERS.unshift(newWO);
    showNotification('OT créé par IA', `${newWO.number} créé automatiquement`, 'success');
    
    // Ajouter message dans le chat
    addChatMessage('ai', `✅ J'ai créé l'ordre de travail **${newWO.number}** pour:\n${diagnostic.equipment} - ${diagnostic.label}\n\nPriorité: ${newWO.priority}\nÉchéance: ${newWO.deadline}\n\nVous pouvez le consulter dans la section "Ordres de Travail".`);
    
    updateWOCounts();
    updateKPIs();
}

function aiAnalyzeHistory() {
    const diagnostics = aiLocalFullDiagnose();
    const history = ALARMS_HISTORY.slice(0, 10);
    
    let text = `📊 **Analyse Historique & Prédictive**\n\n`;
    
    // Tendances
    text += `**Problèmes récurrents:**\n`;
    const equipCounts = {};
    history.forEach(a => {
        equipCounts[a.equipment] = (equipCounts[a.equipment] || 0) + 1;
    });
    Object.entries(equipCounts).forEach(([equip, count]) => {
        text += `• ${equip}: ${count} alarme(s) récente(s)\n`;
    });
    
    // Recommandations prédictives
    text += `\n**Recommandations prédictives:**\n`;
    if (diagnostics.length > 0) {
        const criticalEquip = diagnostics[0].equipment;
        text += `• ${criticalEquip} nécessite une attention immédiate\n`;
        text += `• Planifier maintenance préventive dans les 48h\n`;
    } else {
        text += `• Tous les équipements stables\n`;
        text += `• Prochaine maintenance préventive dans 7 jours\n`;
    }
    
    addChatMessage('ai', text);
}

function aiPredictiveAlert() {
    // Analyser les tendances pour prédire les pannes
    const predictions = [];
    
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const equip = EQUIPMENTS_DATA[equipKey];
        Object.keys(equip.sensors).forEach(sensorKey => {
            const sensor = equip.sensors[sensorKey];
            const trend = (sensor.value / sensor.threshold);
            
            if (trend > 0.8 && trend < 1.0) {
                predictions.push({
                    equipment: equip.name,
                    sensor: sensorKey,
                    current: sensor.value,
                    threshold: sensor.threshold,
                    trend: trend,
                    timeToFailure: Math.round((1 - trend) * 100 / (Math.random() * 0.5 + 0.1)) // Heures estimées
                });
            }
        });
    });
    
    if (predictions.length === 0) {
        addChatMessage('ai', '🔮 **Analyse prédictive**\n\nAucune dégradation significative détectée. Tous les équipements sont dans des marges normales.');
        return;
    }
    
    let text = `🔮 **Alertes Prédictives**\n\nJ'ai détecté des signes avant-coureurs:\n\n`;
    predictions.forEach(p => {
        const emoji = p.trend > 0.9 ? '⚠️' : 'ℹ️';
        text += `${emoji} **${p.equipment}** - ${p.sensor}\n`;
        text += `   Tendance: ${(p.trend * 100).toFixed(0)}% du seuil\n`;
        text += `   Estimation: panne possible dans ~${p.timeToFailure}h\n\n`;
    });
    
    text += `**Recommandation:** Planifier une inspection préventive dans les 24-48h.`;
    
    addChatMessage('ai', text);
    showNotification('Alerte prédictive', `${predictions.length} signe(s) avant-coureur détecté(s)`, 'warning');
}

function aiEmergencyStop() {
    const critical = aiLocalFullDiagnose().filter(d => d.severity === 'critical');
    
    if (critical.length === 0) {
        addChatMessage('ai', `🛑 **Procédure d'arrêt d'urgence**\n\nAucun problème critique détecté actuellement. L'arrêt d'urgence n'est pas nécessaire.\n\nSi vous devez quand même arrêter:\n1. Arrêter la chaîne en mode contrôlé\n2. Isoler l\\'alimentation électrique\n3. Vérifier les sécurités\n4. Attendre le technicien'`);
        return;
    }
    
    let text = `🛑 **ARRÊT D'URGENCE RECOMMANDÉ**\n\nProblèmes critiques détectés:\n`;
    critical.forEach(c => {
        text += `🔴 ${c.equipment}: ${c.label} (${c.value.toFixed(1)}${c.unit})\n`;
    });
    
    text += `\n**Procédure d'arrêt guidée:**\n`;
    text += `1. ⚡ Arrêter immédiatement la chaîne\n`;
    text += `2. 🔌 Couper l'alimentation des équipements concernés\n`;
    text += `3. 🛡️ Activer les sécurités\n`;
    text += `4. 📞 Alerter le superviseur\n`;
    text += `5. 🔍 Ne pas redémarrer sans inspection\n`;
    
    text += `\nJe vais créer un OT d'urgence automatiquement...`;
    
    addChatMessage('ai', text);
    
    // Créer OT d'urgence pour chaque critique
    critical.forEach(c => aiCreateWorkOrderFromDiagnostic(c));
}

// ==================== MISE À JOUR TEMPS RÉEL ====================
function updateAISensorStatus() {
    const container = document.getElementById('aiSensorStatus');
    if (!container) return;
    
    let html = '';
    Object.keys(EQUIPMENTS_DATA).forEach(equipKey => {
        const equip = EQUIPMENTS_DATA[equipKey];
        const hasCritical = Object.values(equip.sensors).some(s => s.status === 'critical');
        const hasWarning = Object.values(equip.sensors).some(s => s.status === 'warning');
        const statusColor = hasCritical ? 'red' : hasWarning ? 'amber' : 'green';
        const statusText = hasCritical ? 'CRITIQUE' : hasWarning ? 'Attention' : 'Normal';
        
        html += `
            <div class="flex items-center justify-between p-2 bg-slate-50 rounded">
                <div class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-${statusColor}-500 pulse-dot"></span>
                    <span class="text-sm font-medium text-slate-700">${equip.name}</span>
                </div>
                <span class="text-xs font-semibold text-${statusColor}-600">${statusText}</span>
            </div>
        `;
        
        // Détail des capteurs problématiques
        Object.entries(equip.sensors).forEach(([sKey, sensor]) => {
            if (sensor.status !== 'normal') {
                html += `
                    <div class="ml-4 flex items-center justify-between py-1">
                        <span class="text-xs text-slate-500 capitalize">${sKey}</span>
                        <span class="text-xs font-mono ${sensor.status === 'critical' ? 'text-red-600' : 'text-amber-600'}">
                            ${sensor.value.toFixed(1)}${sensor.unit}
                        </span>
                    </div>
                `;
            }
        });
    });
    
    container.innerHTML = html;
    
    // Badge IA
    const issues = aiLocalFullDiagnose();
    const aiBadge = document.getElementById('aiBadge');
    if (aiBadge) {
        if (issues.length > 0) {
            aiBadge.textContent = issues.length;
            aiBadge.classList.remove('hidden');
        } else {
            aiBadge.classList.add('hidden');
        }
    }
}

// ==================== PROACTIVITÉ IA ====================
function aiProactiveCheck() {
    if (!AI_CONFIG.proactive) return;
    
    const issues = aiLocalFullDiagnose();
    if (issues.length === 0) return;
    
    // Ne pas spammer : vérifier si on a déjà alerté récemment
    const now = Date.now();
    const lastAlert = AI_CONFIG.lastProactiveAlert || 0;
    if (now - lastAlert < 30000) return; // 30s minimum entre alertes
    
    const critical = issues.filter(i => i.severity === 'critical');
    if (critical.length > 0) {
        AI_CONFIG.lastProactiveAlert = now;
        showNotification('🤖 IA Maintenance', `${critical.length} problème(s) critique(s) détecté(s) sur ${critical[0].equipment}`, 'error');
        
        // Auto-OT si activé
        if (AI_CONFIG.autoOT) {
            critical.forEach(c => aiCreateWorkOrderFromDiagnostic(c));
        }
    }
}

// ==================== CONFIGURATION IA ====================
function toggleAIMode() {
    const modes = ['local', 'hybrid', 'api'];
    const current = AI_CONFIG.mode;
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    AI_CONFIG.mode = next;
    
    const labels = { local: 'Mode: Local', hybrid: 'Mode: Hybride', api: 'Mode: API' };
    
    const btn = document.getElementById('aiModeBtn');
    if (btn) {
        btn.innerHTML = `<i class="fas fa-brain mr-1"></i>${labels[next]}`;
    }
    
    showNotification('Mode IA', `Basculé en ${labels[next]}`, 'info');
}

function changeAIMode(mode) {
    AI_CONFIG.mode = mode;
    showNotification('Configuration IA', `Mode principal: ${mode}`, 'success');
}

function toggleProactive() {
    const checkbox = document.getElementById('aiProactive');
    AI_CONFIG.proactive = checkbox ? checkbox.checked : true;
    showNotification('IA Proactive', AI_CONFIG.proactive ? 'Activée' : 'Désactivée', 'info');
}

// ==================== TEST CONNEXION API ====================
async function testAIConnection() {
    const apiKeyInput = document.getElementById('aiApiKey');
    const statusDiv = document.getElementById('aiApiStatus');
    const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
    
    if (!apiKey) {
        statusDiv.className = 'mt-2 text-xs text-red-600';
        statusDiv.innerHTML = '<i class="fas fa-times-circle mr-1"></i>Entrez d\'abord une clé API';
        statusDiv.classList.remove('hidden');
        return;
    }
    
    if (!apiKey.startsWith('sk-')) {
        statusDiv.className = 'mt-2 text-xs text-amber-600';
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i>La clé doit commencer par "sk-"';
        statusDiv.classList.remove('hidden');
        return;
    }
    
    // Sauvegarder la clé
    AI_CONFIG.apiKey = apiKey;
    localStorage.setItem('ai_api_key', apiKey);
    
    statusDiv.className = 'mt-2 text-xs text-amber-600';
    statusDiv.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Test en cours...';
    statusDiv.classList.remove('hidden');
    
    try {
        // Test avec un appel simple à l'API (models list ou chat simple)
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin || 'http://localhost',
                'X-Title': 'Smart Maintenance System'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const freeModels = data.data ? data.data.filter(m => m.id.includes(':free')) : [];
            
            statusDiv.className = 'mt-2 text-xs text-green-600';
            statusDiv.innerHTML = `<i class="fas fa-check-circle mr-1"></i>Connecté ! ${freeModels.length} modèles gratuits disponibles.`;
            
            showNotification('API Connectée', `OpenRouter OK - ${freeModels.length} modèles gratuits`, 'success');
        } else {
            let errorMsg = `Erreur ${response.status}`;
            try {
                const errData = await response.json();
                errorMsg = errData.error?.message || errorMsg;
            } catch {}
            
            statusDiv.className = 'mt-2 text-xs text-red-600';
            statusDiv.innerHTML = `<i class="fas fa-times-circle mr-1"></i>${errorMsg}`;
            showNotification('Erreur API', errorMsg, 'error');
        }
    } catch (error) {
        statusDiv.className = 'mt-2 text-xs text-red-600';
        statusDiv.innerHTML = `<i class="fas fa-times-circle mr-1"></i>Réseau: ${error.message}`;
        showNotification('Erreur', 'Impossible de contacter OpenRouter. Vérifiez votre connexion.', 'error');
    }
}

// Charger la clé API sauvegardée au démarrage
function loadAIApiKey() {
    const saved = localStorage.getItem('ai_api_key');
    if (saved) {
        AI_CONFIG.apiKey = saved;
        const input = document.getElementById('aiApiKey');
        if (input) {
            input.value = saved;
        }
        console.log('Clé API chargée depuis localStorage');
    }
}

// ==================== INTÉGRATION DANS LA BOUCLE TEMPS RÉEL ====================
// Ajouter dans startRealtimeLoop() :
// updateAISensorStatus();
// aiProactiveCheck();

// ==================== EXPORTS GLOBAUX IA ====================
window.sendAIMessage = sendAIMessage;
window.clearChat = clearChat;
window.quickAsk = quickAsk;
window.toggleChecklistItem = toggleChecklistItem;
window.aiCreateWorkOrder = aiCreateWorkOrder;
window.aiAnalyzeHistory = aiAnalyzeHistory;
window.aiPredictiveAlert = aiPredictiveAlert;
window.aiEmergencyStop = aiEmergencyStop;
window.toggleAIMode = toggleAIMode;
window.changeAIMode = changeAIMode;
window.toggleProactive = toggleProactive;
window.testAIConnection = testAIConnection;
window.loadAIApiKey = loadAIApiKey;
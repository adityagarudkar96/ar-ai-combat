// ================================================================
//  AR AI COMBAT — Smart Target System
//  Game Engine (WebXR + Three.js)
// ================================================================

import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';

// ================================================================
//  CONFIGURATION
// ================================================================
const CONFIG = {
    ENEMY_TYPES: {
        drone: {
            health: 1,
            speed: 0.35,
            score: 10,
            color: 0x00f0ff,
            hoverHeight: 0.18,
            scale: 1.0,
        },
        berserker: {
            health: 2,
            speed: 0.18,
            score: 25,
            color: 0xff2244,
            hoverHeight: 0.14,
            scale: 1.3,
        },
        phantom: {
            health: 1,
            speed: 0.55,
            score: 30,
            color: 0x00ff88,
            hoverHeight: 0.22,
            scale: 0.9,
        },
    },
    SPAWN_WEIGHTS: { drone: 0.5, berserker: 0.3, phantom: 0.2 },
    MAX_ENEMIES: 6,
    INITIAL_ENEMIES: 3,
    SPAWN_INTERVAL: 4,         // seconds between spawns
    SPAWN_RADIUS: 1.5,         // meters from anchor

    // Difficulty (endless survival)
    WAVE_DURATION: 30,         // seconds per wave
    SPEED_INCREASE: 0.12,      // multiplier added per wave
    SPAWN_DECREASE: 0.4,       // seconds faster per wave
    MIN_SPAWN_INTERVAL: 1.5,

    // Combat
    COMBO_MAX: 5,
    SHIELDS: 3,
    AGGRESSION_INTERVAL: [10, 15],
    DODGE_DISTANCE: 0.4,       // meters — near-miss dodge trigger
    DAMAGE_DISTANCE: 0.35,     // meters — enemy reaches player

    // Particles
    PARTICLE_COUNT: 14,
    PARTICLE_LIFE: 0.6,
};

// ================================================================
//  GAME STATE
// ================================================================
const state = {
    isPlaying: false,
    score: 0,
    combo: 1,
    maxCombo: 1,
    kills: 0,
    shots: 0,
    hits: 0,
    shields: CONFIG.SHIELDS,
    wave: 1,

    gameTime: 0,
    spawnTimer: 0,
    waveTimer: 0,
    aggressionTimer: 0,
    nextAggression: 0,

    surfaceDetected: false,
    surfaceY: 0,
    anchorPosition: new THREE.Vector3(),
    scanPhase: 'idle', // idle | scanning | detected | deploying | playing | gameover

    speedMultiplier: 1,
    spawnInterval: CONFIG.SPAWN_INTERVAL,

    enemies: [],
    particles: [],
};

// ================================================================
//  ENGINE VARIABLES
// ================================================================
let scene, camera, renderer;
let reticle;
let hitTestSource = null;
let hitTestSourceRequested = false;
let controller;
let raycaster;
let clock;

// DOM cache
const dom = {};

// Audio
let audioCtx = null;

// ================================================================
//  INITIALIZATION
// ================================================================
function init() {
    cacheDom();
    setupScene();
    setupLights();
    setupReticle();
    setupWebXR();

    dom.restartBtn.addEventListener('click', restartGame);
    dom.restartBtn.addEventListener('touchend', (e) => { e.preventDefault(); restartGame(); });

    clock = new THREE.Clock();
}

function cacheDom() {
    dom.overlay = document.getElementById('overlay');
    dom.startScreen = document.getElementById('start-screen');
    dom.hud = document.getElementById('hud');
    dom.crosshair = document.getElementById('crosshair');
    dom.scoreValue = document.getElementById('score-value');
    dom.comboValue = document.getElementById('combo-value');
    dom.comboPanel = document.getElementById('combo-panel');
    dom.waveValue = document.getElementById('wave-value');
    dom.killsValue = document.getElementById('kills-value');
    dom.statusText = document.getElementById('status-text');
    dom.statusBar = document.getElementById('status-bar');
    dom.muzzleFlash = document.getElementById('muzzle-flash');
    dom.hitMarker = document.getElementById('hit-marker');
    dom.alertText = document.getElementById('alert-text');
    dom.gameOver = document.getElementById('game-over');
    dom.gameOverTitle = document.getElementById('game-over-title');
    dom.finalScore = document.getElementById('final-score');
    dom.finalKills = document.getElementById('final-kills');
    dom.finalAccuracy = document.getElementById('final-accuracy');
    dom.finalCombo = document.getElementById('final-combo');
    dom.finalWaves = document.getElementById('final-waves');
    dom.restartBtn = document.getElementById('restart-btn');
    dom.shieldsContainer = document.getElementById('shields-container');
    dom.arButtonContainer = document.getElementById('ar-button-container');
    dom.notSupported = document.getElementById('not-supported');
}

// ================================================================
//  THREE.JS SCENE
// ================================================================
function setupScene() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    raycaster = new THREE.Raycaster();
}

function setupLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444488, 1.2);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 2, 1);
    scene.add(dir);
}

// ================================================================
//  SURFACE RETICLE
// ================================================================
function setupReticle() {
    const geo = new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
    });
    reticle = new THREE.Mesh(geo, mat);
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);
}

// ================================================================
//  WEBXR SETUP
// ================================================================
function setupWebXR() {
    // Check support
    if (!navigator.xr) {
        dom.notSupported.style.display = 'block';
        dom.notSupported.textContent = 'WebXR is not supported in this browser. Please use Chrome on Android.';
        return;
    }

    navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
        if (!supported) {
            dom.notSupported.style.display = 'block';
            dom.notSupported.textContent = 'Immersive AR is not supported on this device. Use Chrome on an ARCore-compatible Android phone.';
            return;
        }

        // Create AR button
        const arButton = ARButton.createButton(renderer, {
            requiredFeatures: ['hit-test'],
            optionalFeatures: ['dom-overlay'],
            domOverlay: { root: dom.overlay },
        });

        // Override default ARButton styles to match our theme
        arButton.style.cssText = `
            position: relative !important;
            bottom: auto !important;
            left: auto !important;
            transform: none !important;
            width: auto !important;
            padding: 16px 48px !important;
            font-family: 'Orbitron', sans-serif !important;
            font-size: 14px !important;
            font-weight: 700 !important;
            letter-spacing: 3px !important;
            color: #00f0ff !important;
            background: rgba(0, 240, 255, 0.1) !important;
            border: 2px solid #00f0ff !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            text-transform: uppercase !important;
            z-index: 1 !important;
            pointer-events: auto !important;
        `;

        dom.arButtonContainer.appendChild(arButton);
    });

    // Session lifecycle
    renderer.xr.addEventListener('sessionstart', onSessionStart);
    renderer.xr.addEventListener('sessionend', onSessionEnd);

    // XR Controller (screen taps → select events)
    controller = renderer.xr.getController(0);
    controller.addEventListener('select', onSelect);
    scene.add(controller);

    // Start render loop
    renderer.setAnimationLoop(onXRFrame);
}

// ================================================================
//  AR SESSION LIFECYCLE
// ================================================================
function onSessionStart() {
    initAudio();

    dom.startScreen.style.display = 'none';
    dom.hud.style.display = 'block';
    dom.crosshair.style.display = 'block';
    dom.gameOver.style.display = 'none';

    resetState();
    state.scanPhase = 'scanning';
    setStatus('SCANNING ENVIRONMENT...');
}

function onSessionEnd() {
    dom.startScreen.style.display = 'flex';
    dom.hud.style.display = 'none';
    dom.crosshair.style.display = 'none';
    dom.gameOver.style.display = 'none';

    cleanupGame();
    hitTestSource = null;
    hitTestSourceRequested = false;
    state.scanPhase = 'idle';
}

// ================================================================
//  GAME FLOW
// ================================================================
function resetState() {
    state.isPlaying = false;
    state.score = 0;
    state.combo = 1;
    state.maxCombo = 1;
    state.kills = 0;
    state.shots = 0;
    state.hits = 0;
    state.shields = CONFIG.SHIELDS;
    state.wave = 1;
    state.gameTime = 0;
    state.spawnTimer = 0;
    state.waveTimer = 0;
    state.aggressionTimer = 0;
    state.nextAggression = randomInRange(...CONFIG.AGGRESSION_INTERVAL);
    state.surfaceDetected = false;
    state.speedMultiplier = 1;
    state.spawnInterval = CONFIG.SPAWN_INTERVAL;

    updateHUD();
    updateShields();
}

function cleanupGame() {
    for (const enemy of state.enemies) {
        scene.remove(enemy.group);
    }
    state.enemies = [];

    for (const p of state.particles) {
        scene.remove(p);
    }
    state.particles = [];
}

function startGame() {
    state.isPlaying = true;
    state.scanPhase = 'playing';
    state.gameTime = 0;
    reticle.visible = false;

    clock.getDelta(); // flush delta

    showAlert('TARGETS DEPLOYED');
    setStatus('ENGAGE TARGETS');

    // Spawn initial enemies with staggered timing
    for (let i = 0; i < CONFIG.INITIAL_ENEMIES; i++) {
        setTimeout(() => spawnEnemy(), i * 600);
    }
}

function gameOver() {
    state.isPlaying = false;
    state.scanPhase = 'gameover';

    dom.gameOver.style.display = 'flex';
    dom.crosshair.style.display = 'none';

    dom.gameOverTitle.textContent = 'MISSION FAILED';
    dom.finalScore.textContent = state.score;
    dom.finalKills.textContent = state.kills;
    dom.finalAccuracy.textContent = state.shots > 0
        ? Math.round((state.hits / state.shots) * 100) + '%'
        : '0%';
    dom.finalCombo.textContent = '×' + state.maxCombo;
    dom.finalWaves.textContent = state.wave;

    showAlert('ALL SHIELDS DESTROYED');
}

function restartGame() {
    dom.gameOver.style.display = 'none';
    dom.crosshair.style.display = 'block';

    cleanupGame();
    resetState();

    if (state.surfaceDetected) {
        startGame();
    } else {
        state.scanPhase = 'scanning';
        setStatus('SCANNING ENVIRONMENT...');
    }
}

// ================================================================
//  ENEMY MESH CREATION
// ================================================================
function createEnemyMesh(type) {
    const group = new THREE.Group();
    const cfg = CONFIG.ENEMY_TYPES[type];
    const color = cfg.color;

    switch (type) {
        case 'drone': {
            // Core sphere
            const core = new THREE.Mesh(
                new THREE.SphereGeometry(0.055, 16, 16),
                new THREE.MeshStandardMaterial({
                    color: 0x001122,
                    emissive: color,
                    emissiveIntensity: 0.8,
                    metalness: 0.9,
                    roughness: 0.2,
                    transparent: true,
                    opacity: 0.9,
                })
            );
            group.add(core);

            // Primary ring
            const ring1 = new THREE.Mesh(
                new THREE.TorusGeometry(0.09, 0.007, 8, 32),
                new THREE.MeshStandardMaterial({
                    color: color,
                    emissive: color,
                    emissiveIntensity: 0.5,
                    transparent: true,
                    opacity: 0.7,
                })
            );
            ring1.rotation.x = Math.PI / 2;
            ring1.name = 'ring1';
            group.add(ring1);

            // Secondary ring (tilted, counter-rotating)
            const ring2 = new THREE.Mesh(
                new THREE.TorusGeometry(0.075, 0.005, 8, 24),
                new THREE.MeshStandardMaterial({
                    color: color,
                    emissive: color,
                    emissiveIntensity: 0.4,
                    transparent: true,
                    opacity: 0.5,
                })
            );
            ring2.rotation.x = Math.PI / 3;
            ring2.name = 'ring2';
            group.add(ring2);
            break;
        }

        case 'berserker': {
            // Inner solid crystal
            const crystal = new THREE.Mesh(
                new THREE.OctahedronGeometry(0.07, 0),
                new THREE.MeshStandardMaterial({
                    color: 0x220011,
                    emissive: color,
                    emissiveIntensity: 0.9,
                    metalness: 0.95,
                    roughness: 0.1,
                    transparent: true,
                    opacity: 0.9,
                })
            );
            crystal.name = 'crystal';
            group.add(crystal);

            // Outer wireframe cage
            const cage = new THREE.Mesh(
                new THREE.OctahedronGeometry(0.095, 0),
                new THREE.MeshBasicMaterial({
                    color: color,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.35,
                })
            );
            cage.name = 'cage';
            group.add(cage);
            break;
        }

        case 'phantom': {
            // Gem body
            const gem = new THREE.Mesh(
                new THREE.IcosahedronGeometry(0.05, 0),
                new THREE.MeshStandardMaterial({
                    color: 0x002211,
                    emissive: color,
                    emissiveIntensity: 0.7,
                    metalness: 0.7,
                    roughness: 0.3,
                    transparent: true,
                    opacity: 0.8,
                })
            );
            gem.name = 'gem';
            group.add(gem);

            // Wireframe aura
            const aura = new THREE.Mesh(
                new THREE.IcosahedronGeometry(0.07, 0),
                new THREE.MeshBasicMaterial({
                    color: color,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.25,
                })
            );
            aura.name = 'aura';
            group.add(aura);
            break;
        }
    }

    // Additive glow sprite
    const spriteMat = new THREE.SpriteMaterial({
        color: color,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Sprite(spriteMat);
    glow.scale.setScalar(0.28 * cfg.scale);
    glow.name = 'glow';
    group.add(glow);

    group.scale.setScalar(cfg.scale);
    return group;
}

// ================================================================
//  ENEMY SPAWNING
// ================================================================
function spawnEnemy() {
    const maxAllowed = CONFIG.MAX_ENEMIES + Math.floor((state.wave - 1) / 3);
    if (state.enemies.length >= maxAllowed) return;

    // Weighted random type
    const roll = Math.random();
    let type;
    if (roll < CONFIG.SPAWN_WEIGHTS.drone) type = 'drone';
    else if (roll < CONFIG.SPAWN_WEIGHTS.drone + CONFIG.SPAWN_WEIGHTS.berserker) type = 'berserker';
    else type = 'phantom';

    const cfg = CONFIG.ENEMY_TYPES[type];
    const group = createEnemyMesh(type);

    // Random position offset from anchor
    const angle = Math.random() * Math.PI * 2;
    const dist = 0.6 + Math.random() * CONFIG.SPAWN_RADIUS;
    const x = state.anchorPosition.x + Math.cos(angle) * dist;
    const z = state.anchorPosition.z + Math.sin(angle) * dist;
    const y = state.surfaceY + cfg.hoverHeight;

    group.position.set(x, y, z);
    group.scale.setScalar(0.01); // start tiny for spawn animation
    scene.add(group);

    const enemy = {
        type,
        group,
        health: cfg.health,
        maxHealth: cfg.health,
        speed: cfg.speed,
        baseSpeed: cfg.speed,
        currentSpeed: cfg.speed * state.speedMultiplier,
        alive: true,

        // Patrol
        patrolAngle: Math.random() * Math.PI * 2,
        patrolRadius: 0.3 + Math.random() * 0.7,
        patrolCenterX: x,
        patrolCenterZ: z,
        homeY: y,

        // AI state machine
        aiState: 'spawning',
        stateTimer: 0,
        dirChangeTimer: 0,
        speedChangeTimer: 0,

        // Spawn animation
        spawnProgress: 0,
        targetScale: cfg.scale,

        // Dodge
        isDodging: false,
        dodgeTarget: new THREE.Vector3(),
        dodgeProgress: 0,
        dodgeOrigin: new THREE.Vector3(),

        // Phantom specific
        cloakTimer: Math.random() * 2,
        cloaked: false,
    };

    state.enemies.push(enemy);

    if (state.enemies.length <= CONFIG.INITIAL_ENEMIES + 1) {
        showAlert(`${type.toUpperCase()} DETECTED`);
    }
}

// ================================================================
//  ENEMY AI & MOVEMENT
// ================================================================
function updateEnemies(dt) {
    for (let i = state.enemies.length - 1; i >= 0; i--) {
        const enemy = state.enemies[i];
        if (!enemy.alive) continue;
        updateEnemyAI(enemy, dt);
        updateEnemyVisuals(enemy, dt);
    }
}

function updateEnemyAI(enemy, dt) {
    const cfg = CONFIG.ENEMY_TYPES[enemy.type];

    // ---- SPAWN ANIMATION ----
    if (enemy.aiState === 'spawning') {
        enemy.spawnProgress += dt * 2.5;
        const t = Math.min(enemy.spawnProgress, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        enemy.group.scale.setScalar(eased * enemy.targetScale);
        if (t >= 1) enemy.aiState = 'patrol';
        return;
    }

    // ---- DODGE (overrides everything) ----
    if (enemy.isDodging) {
        enemy.dodgeProgress += dt * 6;
        const t = Math.min(enemy.dodgeProgress, 1);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out cubic

        enemy.group.position.x = THREE.MathUtils.lerp(enemy.dodgeOrigin.x, enemy.dodgeTarget.x, eased);
        enemy.group.position.z = THREE.MathUtils.lerp(enemy.dodgeOrigin.z, enemy.dodgeTarget.z, eased);

        if (t >= 1) {
            enemy.isDodging = false;
            enemy.patrolCenterX = enemy.group.position.x;
            enemy.patrolCenterZ = enemy.group.position.z;
            enemy.aiState = 'patrol';
        }
        return;
    }

    // ---- SPEED VARIATION ----
    enemy.speedChangeTimer += dt;
    if (enemy.speedChangeTimer > 2 + Math.random() * 2) {
        enemy.speedChangeTimer = 0;
        enemy.currentSpeed = enemy.baseSpeed * state.speedMultiplier * (0.7 + Math.random() * 0.6);
    }

    // ---- STATE BEHAVIORS ----
    switch (enemy.aiState) {
        case 'patrol':
            patrolBehavior(enemy, dt);
            break;
        case 'aggressive':
            aggressiveBehavior(enemy, dt);
            break;
    }

    // ---- PHANTOM CLOAKING ----
    if (enemy.type === 'phantom') {
        enemy.cloakTimer += dt;
        if (enemy.cloakTimer > 2) {
            enemy.cloakTimer = 0;
            enemy.cloaked = !enemy.cloaked;
        }
    }

    // ---- HOVER BOB ----
    const bob = Math.sin(Date.now() * 0.003 + enemy.patrolAngle * 10) * 0.015;
    enemy.group.position.y = enemy.homeY + bob;
}

function patrolBehavior(enemy, dt) {
    enemy.patrolAngle += enemy.currentSpeed * dt;

    const targetX = enemy.patrolCenterX + Math.cos(enemy.patrolAngle) * enemy.patrolRadius;
    const targetZ = enemy.patrolCenterZ + Math.sin(enemy.patrolAngle * 0.7) * enemy.patrolRadius;

    // Smooth move toward target
    enemy.group.position.x += (targetX - enemy.group.position.x) * dt * 2;
    enemy.group.position.z += (targetZ - enemy.group.position.z) * dt * 2;

    // Random direction/radius change
    enemy.dirChangeTimer += dt;
    if (enemy.dirChangeTimer > 1.5 + Math.random() * 2) {
        enemy.dirChangeTimer = 0;
        enemy.patrolRadius = 0.2 + Math.random() * 0.8;
    }
}

function aggressiveBehavior(enemy, dt) {
    const target = state.anchorPosition;
    const dx = target.x - enemy.group.position.x;
    const dz = target.z - enemy.group.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > CONFIG.DAMAGE_DISTANCE) {
        const speed = enemy.currentSpeed * 2.5;
        enemy.group.position.x += (dx / dist) * speed * dt;
        enemy.group.position.z += (dz / dist) * speed * dt;
    } else {
        // Reached player → deal damage
        damagePlayer();

        // Teleport enemy to new far position
        const angle = Math.random() * Math.PI * 2;
        const newDist = 1 + Math.random() * CONFIG.SPAWN_RADIUS;
        enemy.patrolCenterX = state.anchorPosition.x + Math.cos(angle) * newDist;
        enemy.patrolCenterZ = state.anchorPosition.z + Math.sin(angle) * newDist;
        enemy.group.position.x = enemy.patrolCenterX;
        enemy.group.position.z = enemy.patrolCenterZ;
        enemy.aiState = 'patrol';
    }

    // Timeout aggression after 8 seconds
    enemy.stateTimer += dt;
    if (enemy.stateTimer > 8) {
        enemy.aiState = 'patrol';
    }
}

function triggerDodge(enemy) {
    if (enemy.isDodging || enemy.aiState === 'spawning') return;

    const dx = enemy.group.position.x - state.anchorPosition.x;
    const dz = enemy.group.position.z - state.anchorPosition.z;
    const len = Math.max(Math.sqrt(dx * dx + dz * dz), 0.1);

    const dodgeDist = 0.25 + Math.random() * 0.3;
    const side = Math.random() > 0.5 ? 1 : -1;

    enemy.isDodging = true;
    enemy.dodgeProgress = 0;
    enemy.dodgeOrigin.copy(enemy.group.position);
    enemy.dodgeTarget.set(
        enemy.group.position.x + (-dz / len) * side * dodgeDist,
        enemy.group.position.y,
        enemy.group.position.z + (dx / len) * side * dodgeDist,
    );
}

function triggerAggression() {
    const alive = state.enemies.filter(e => e.alive && e.aiState === 'patrol');
    if (alive.length === 0) return;

    const enemy = alive[Math.floor(Math.random() * alive.length)];
    enemy.aiState = 'aggressive';
    enemy.stateTimer = 0;
    enemy.currentSpeed = enemy.baseSpeed * state.speedMultiplier * 1.8;

    showAlert('⚠ INCOMING THREAT');
}

// ================================================================
//  ENEMY VISUALS
// ================================================================
function updateEnemyVisuals(enemy, dt) {
    const now = Date.now();

    enemy.group.children.forEach((child) => {
        if (child.isSprite) return;

        // General rotation
        child.rotation.y += dt * (enemy.type === 'berserker' ? 1.8 : 1.0);

        // Drone ring counter-rotation
        if (enemy.type === 'drone' && child.name === 'ring2') {
            child.rotation.z += dt * 2.5;
        }
    });

    // Phantom cloaking
    if (enemy.type === 'phantom') {
        const targetOp = enemy.cloaked ? 0.12 : 0.8;
        enemy.group.children.forEach((child) => {
            if (child.material && child.material.opacity !== undefined) {
                child.material.opacity += (targetOp - child.material.opacity) * dt * 5;
            }
        });
    }

    // Berserker pulse
    if (enemy.type === 'berserker') {
        const pulse = 0.6 + Math.sin(now * 0.005) * 0.35;
        enemy.group.children.forEach((child) => {
            if (child.material?.emissiveIntensity !== undefined) {
                child.material.emissiveIntensity = pulse;
            }
        });
    }

    // Glow sprite pulse
    const glowSprite = enemy.group.getObjectByName('glow');
    if (glowSprite) {
        const gPulse = 0.08 + Math.sin(now * 0.004) * 0.05;
        glowSprite.material.opacity = gPulse;
    }
}

// ================================================================
//  SHOOTING
// ================================================================
function onSelect() {
    // If not playing: tap to deploy if surface found
    if (!state.isPlaying) {
        if (state.surfaceDetected && state.scanPhase === 'detected') {
            state.scanPhase = 'deploying';
            setStatus('DEPLOYING TARGETS...');
            showAlert('INITIATING COMBAT');
            setTimeout(() => startGame(), 1200);
        }
        return;
    }

    // Ignore during game over
    if (state.scanPhase === 'gameover') return;

    // ---- SHOOT! ----
    state.shots++;
    playShootSound();
    showMuzzleFlash();

    // Raycast from camera center (where crosshair is)
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    // Collect all live enemy groups
    const meshes = state.enemies.filter(e => e.alive).map(e => e.group);
    const intersects = raycaster.intersectObjects(meshes, true);

    if (intersects.length > 0) {
        const hitObj = intersects[0].object;
        const hitPt = intersects[0].point;

        for (const enemy of state.enemies) {
            if (!enemy.alive) continue;
            if (isDescendant(hitObj, enemy.group)) {
                onEnemyHit(enemy, hitPt);
                break;
            }
        }
    } else {
        onMiss();

        // Near-miss dodge trigger
        for (const enemy of state.enemies) {
            if (!enemy.alive || enemy.aiState === 'spawning') continue;

            const closest = new THREE.Vector3();
            raycaster.ray.closestPointToPoint(enemy.group.position, closest);
            const dist = closest.distanceTo(enemy.group.position);

            if (dist < CONFIG.DODGE_DISTANCE) {
                triggerDodge(enemy);
            }
        }
    }
}

function onEnemyHit(enemy, point) {
    state.hits++;

    enemy.health--;
    playHitSound();
    showHitMarker();
    showScreenShake();

    // White flash on enemy
    const origMats = [];
    enemy.group.traverse((child) => {
        if (child.material && !child.isSprite) {
            origMats.push({ mesh: child, mat: child.material });
            child.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
        }
    });
    setTimeout(() => {
        origMats.forEach(({ mesh, mat }) => { mesh.material = mat; });
    }, 80);

    if (enemy.health <= 0) {
        // ---- DESTROYED ----
        enemy.alive = false;

        const cfg = CONFIG.ENEMY_TYPES[enemy.type];
        const points = cfg.score * state.combo;
        state.score += points;
        state.kills++;

        state.combo = Math.min(state.combo + 1, CONFIG.COMBO_MAX);
        state.maxCombo = Math.max(state.maxCombo, state.combo);

        spawnExplosion(enemy.group.position.clone(), cfg.color);
        playExplosionSound();

        showAlert('+' + points);

        scene.remove(enemy.group);
        state.enemies = state.enemies.filter(e => e !== enemy);
    }

    updateHUD();
}

function onMiss() {
    state.combo = 1;
    updateHUD();
}

function damagePlayer() {
    state.shields--;
    updateShields();
    showScreenShake();
    playExplosionSound();

    // Red damage flash
    dom.muzzleFlash.classList.add('damage');
    dom.muzzleFlash.classList.add('active');
    setTimeout(() => {
        dom.muzzleFlash.classList.remove('active');
        dom.muzzleFlash.classList.remove('damage');
    }, 200);

    if (state.shields <= 0) {
        gameOver();
    } else {
        showAlert('⚠ SHIELD DAMAGED');
    }
}

// ================================================================
//  PARTICLE EXPLOSIONS
// ================================================================
function spawnExplosion(position, color) {
    // ---- 1. Shockwave Blast ----
    const ringGeo = new THREE.TorusGeometry(0.02, 0.005, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.8
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(position);
    ring.lookAt(camera.position); // Face the camera
    ring.userData.type = 'shockwave';
    ring.userData.life = 0.4;
    ring.userData.maxLife = 0.4;
    scene.add(ring);
    state.particles.push(ring);

    // ---- 2. Debris Particles (existing) ----
    for (let i = 0; i < CONFIG.PARTICLE_COUNT; i++) {
        const size = 0.006 + Math.random() * 0.01;
        const particle = new THREE.Mesh(
            new THREE.SphereGeometry(size, 4, 4),
            new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: 1,
            })
        );

        particle.position.copy(position);
        particle.userData.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 1.8,
            Math.random() * 2.0,
            (Math.random() - 0.5) * 1.8
        );
        particle.userData.life = CONFIG.PARTICLE_LIFE;
        particle.userData.maxLife = CONFIG.PARTICLE_LIFE;

        scene.add(particle);
        state.particles.push(particle);
    }
}

function updateParticles(dt) {
    for (let i = state.particles.length - 1; i >= 0; i--) {
        const p = state.particles[i];
        p.userData.life -= dt;

        if (p.userData.life <= 0) {
            scene.remove(p);
            state.particles.splice(i, 1);
            continue;
        }

        // Physics
        if (p.userData.type === 'shockwave') {
            const t = 1 - (p.userData.life / p.userData.maxLife);
            p.scale.setScalar(1 + t * 15);
            p.material.opacity = (1 - t) * 0.8;
        } else {
            p.position.add(p.userData.velocity.clone().multiplyScalar(dt));
            p.userData.velocity.y -= 3 * dt; // gravity

            // Fade & shrink
            const t = p.userData.life / p.userData.maxLife;
            p.material.opacity = t;
            p.scale.setScalar(t);
        }
    }
}

// ================================================================
//  UI EFFECTS
// ================================================================
function showMuzzleFlash() {
    dom.muzzleFlash.classList.add('active');
    dom.crosshair.classList.add('recoil');
    
    setTimeout(() => {
        dom.muzzleFlash.classList.remove('active');
        dom.crosshair.classList.remove('recoil');
    }, 80);
}

function showHitMarker() {
    dom.hitMarker.style.display = 'block';
    dom.hitMarker.classList.remove('active');
    void dom.hitMarker.offsetWidth; // reflow
    dom.hitMarker.classList.add('active');
    setTimeout(() => {
        dom.hitMarker.classList.remove('active');
        dom.hitMarker.style.display = 'none';
    }, 250);
}

function showScreenShake() {
    dom.overlay.classList.remove('shake');
    void dom.overlay.offsetWidth;
    dom.overlay.classList.add('shake');
    setTimeout(() => dom.overlay.classList.remove('shake'), 150);
}

function showAlert(text) {
    dom.alertText.textContent = text;
    dom.alertText.style.display = 'block';
    dom.alertText.classList.remove('active');
    void dom.alertText.offsetWidth;
    dom.alertText.classList.add('active');
    setTimeout(() => {
        dom.alertText.style.display = 'none';
        dom.alertText.classList.remove('active');
    }, 1500);
}

function setStatus(text) {
    dom.statusText.textContent = text;
}

function updateHUD() {
    dom.scoreValue.textContent = state.score;
    dom.comboValue.textContent = '×' + state.combo;
    dom.waveValue.textContent = state.wave;
    dom.killsValue.textContent = state.kills;

    if (state.combo > 1) {
        dom.comboPanel.classList.add('active');
        // bump animation
        dom.comboPanel.classList.remove('bump');
        void dom.comboPanel.offsetWidth;
        dom.comboPanel.classList.add('bump');
        setTimeout(() => dom.comboPanel.classList.remove('bump'), 200);
    } else {
        dom.comboPanel.classList.remove('active');
    }
}

function updateShields() {
    const container = dom.shieldsContainer;
    container.innerHTML = '';
    for (let i = 0; i < CONFIG.SHIELDS; i++) {
        const icon = document.createElement('div');
        icon.className = 'shield-icon ' + (i < state.shields ? 'active' : 'depleted');
        container.appendChild(icon);
    }
}

// ================================================================
//  AUDIO (Web Audio API — Programmatic SFX)
// ================================================================
function initAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
        console.warn('Audio not available:', e);
    }
}

function playShootSound() {
    if (!audioCtx) return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'square';
        osc.frequency.setValueAtTime(900, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, audioCtx.currentTime + 0.06);

        gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);

        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.08);
    } catch (e) { /* ignore audio errors */ }
}

function playHitSound() {
    if (!audioCtx) return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(700, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.12);

        gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);

        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) { /* ignore audio errors */ }
}

function playExplosionSound() {
    if (!audioCtx) return;
    try {
        const len = Math.floor(audioCtx.sampleRate * 0.25);
        const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < len; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
        }

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;

        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);

        source.connect(gain);
        gain.connect(audioCtx.destination);
        source.start();
    } catch (e) { /* ignore audio errors */ }
}

// ================================================================
//  MAIN GAME LOOP (WebXR Animation Frame)
// ================================================================
function onXRFrame(timestamp, frame) {
    // ---- HIT TESTING (surface detection) ----
    if (frame) {
        const session = renderer.xr.getSession();
        const localRefSpace = renderer.xr.getReferenceSpace();

        // Request hit-test source (once per session)
        if (!hitTestSourceRequested && session) {
            session.requestReferenceSpace('viewer').then((viewerSpace) => {
                if (session.requestHitTestSource) {
                    session.requestHitTestSource({ space: viewerSpace }).then((source) => {
                        hitTestSource = source;
                    });
                }
            });
            hitTestSourceRequested = true;

            session.addEventListener('end', () => {
                hitTestSource = null;
                hitTestSourceRequested = false;
            });
        }

        // Process hit test results
        if (hitTestSource && localRefSpace) {
            const results = frame.getHitTestResults(hitTestSource);

            if (results.length > 0) {
                const pose = results[0].getPose(localRefSpace);

                if (pose) {
                    reticle.visible = true;
                    reticle.matrix.fromArray(pose.transform.matrix);

                    // First surface detection
                    if (!state.surfaceDetected && state.scanPhase === 'scanning') {
                        state.surfaceDetected = true;
                        state.scanPhase = 'detected';

                        const p = pose.transform.position;
                        state.surfaceY = p.y;
                        state.anchorPosition.set(p.x, p.y, p.z);

                        setStatus('SURFACE LOCKED — TAP TO DEPLOY');
                        showAlert('SURFACE DETECTED');
                    }

                    // Keep updating anchor during scanning phases
                    if (state.scanPhase === 'detected' || state.scanPhase === 'scanning') {
                        const p = pose.transform.position;
                        state.surfaceY = p.y;
                        state.anchorPosition.set(p.x, p.y, p.z);
                    }
                }
            } else {
                reticle.visible = false;
            }
        }

        // Hide reticle during gameplay
        if (state.isPlaying) {
            reticle.visible = false;
        }
    }

    // ---- GAME UPDATE ----
    const dt = Math.min(clock.getDelta(), 0.1); // cap delta to avoid huge jumps

    if (state.isPlaying) {
        state.gameTime += dt;

        // Spawn timer
        state.spawnTimer += dt;
        if (state.spawnTimer >= state.spawnInterval) {
            state.spawnTimer = 0;
            spawnEnemy();
        }

        // Wave / difficulty scaling
        state.waveTimer += dt;
        if (state.waveTimer >= CONFIG.WAVE_DURATION) {
            state.waveTimer = 0;
            state.wave++;
            state.speedMultiplier = 1 + (state.wave - 1) * CONFIG.SPEED_INCREASE;
            state.spawnInterval = Math.max(
                CONFIG.MIN_SPAWN_INTERVAL,
                CONFIG.SPAWN_INTERVAL - (state.wave - 1) * CONFIG.SPAWN_DECREASE
            );

            // Update existing enemies
            state.enemies.forEach((e) => {
                e.currentSpeed = e.baseSpeed * state.speedMultiplier;
            });

            showAlert('WAVE ' + state.wave);
            setStatus('WAVE ' + state.wave + ' — THREAT ESCALATING');
            updateHUD();
        }

        // Aggression timer
        state.aggressionTimer += dt;
        if (state.aggressionTimer >= state.nextAggression) {
            state.aggressionTimer = 0;
            state.nextAggression = randomInRange(
                CONFIG.AGGRESSION_INTERVAL[0] / state.speedMultiplier,
                CONFIG.AGGRESSION_INTERVAL[1] / state.speedMultiplier
            );
            triggerAggression();
        }

        // Update enemies & particles
        updateEnemies(dt);
        updateParticles(dt);
    }

    // ---- RENDER ----
    renderer.render(scene, camera);
}

// ================================================================
//  UTILITIES
// ================================================================
function randomInRange(min, max) {
    return min + Math.random() * (max - min);
}

function isDescendant(child, parent) {
    let node = child;
    while (node) {
        if (node === parent) return true;
        node = node.parent;
    }
    return false;
}

// ================================================================
//  START
// ================================================================
init();

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const TEAL = 0x00c9b1;
const TEAL_DARK = 0x00a895;
const POLE_HEIGHT_M = 3.2; // ceiling height used for the pole cylinders — adjust here
const POLE_RADIUS_M = 0.06;

let container, renderer, labelRenderer, scene, camera, controls;
let groundMesh, gridHelper, poleGroup;
let sharedPoleGeo, sharedPoleMat, sharedDiscGeo, sharedDiscMat;
let rafId = null;
let active = false;
let lastData = null;
let framedKey = null;

function ensureScene() {
  if (scene) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2;
  controls.maxDistance = 60;

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(8, 12, 6);
  scene.add(dirLight);

  poleGroup = new THREE.Group();
  scene.add(poleGroup);

  window.addEventListener('resize', resize);
}

function resize() {
  if (!renderer || !container) return;
  const w = container.clientWidth || 1;
  const h = container.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
}

// Rebuilds the floor + re-frames the camera only when room dimensions actually
// change, so tweaking pole count / spacing doesn't reset the user's orbit view.
function syncGround(roomW, roomH) {
  const key = roomW + 'x' + roomH;
  if (key === framedKey) return;
  framedKey = key;

  if (groundMesh) { scene.remove(groundMesh); groundMesh.geometry.dispose(); groundMesh.material.dispose(); }
  if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); }

  const groundGeo = new THREE.PlaneGeometry(roomW, roomH);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.set(roomW / 2, 0, roomH / 2);
  scene.add(groundMesh);

  const divisions = Math.max(1, Math.round(Math.max(roomW, roomH)));
  gridHelper = new THREE.GridHelper(Math.max(roomW, roomH), divisions, TEAL, 0xe5e7eb);
  gridHelper.position.set(roomW / 2, 0.001, roomH / 2);
  scene.add(gridHelper);

  const dist = Math.max(roomW, roomH);
  controls.target.set(roomW / 2, 0, roomH / 2);
  camera.position.set(roomW / 2 + dist * 0.6, dist * 0.65 + 2.5, roomH / 2 + dist * 0.9);
  controls.update();
}

function disposeShared() {
  [sharedPoleGeo, sharedDiscGeo].forEach(g => g && g.dispose());
  [sharedPoleMat, sharedDiscMat].forEach(m => m && m.dispose());
}

function rebuildPoles(poles, radiusM) {
  poleGroup.children.forEach(child => { if (child.isCSS2DObject) child.element.remove(); });
  poleGroup.clear();
  disposeShared();

  sharedPoleGeo = new THREE.CylinderGeometry(POLE_RADIUS_M, POLE_RADIUS_M, POLE_HEIGHT_M, 16);
  sharedPoleMat = new THREE.MeshStandardMaterial({ color: TEAL_DARK, metalness: 0.3, roughness: 0.4 });
  sharedDiscGeo = new THREE.CircleGeometry(Math.max(radiusM, 0.01), 40);
  sharedDiscMat = new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.18, side: THREE.DoubleSide });

  poles.forEach(function(p) {
    const x = p.x, z = p.y; // room's 2D y (depth) maps to 3D's z axis

    const pole = new THREE.Mesh(sharedPoleGeo, sharedPoleMat);
    pole.position.set(x, POLE_HEIGHT_M / 2, z);
    poleGroup.add(pole);

    const disc = new THREE.Mesh(sharedDiscGeo, sharedDiscMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.002, z);
    poleGroup.add(disc);

    const labelDiv = document.createElement('div');
    labelDiv.className = 'pole-label-3d';
    labelDiv.textContent = p.label;
    const label = new CSS2DObject(labelDiv);
    label.position.set(x, POLE_HEIGHT_M + 0.35, z);
    poleGroup.add(label);
  });
}

function renderFrame() {
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function animate() {
  if (!active) return;
  rafId = requestAnimationFrame(animate);
  controls.update();
  renderFrame();
}

function applyData(data) {
  syncGround(data.roomW, data.roomH);
  rebuildPoles(data.poles, data.spacing);
}

const SpaceView3D = {
  init(el) {
    if (container) return; // already initialized once, container doesn't change
    container = el;
    ensureScene();
    resize();
    if (lastData) applyData(lastData);
  },
  setActive(on) {
    active = on;
    if (!scene) return;
    if (on) {
      resize();
      if (rafId == null) animate();
    } else if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  },
  update(data) {
    lastData = data;
    if (!scene) return; // 3D view not opened yet — nothing to draw into
    applyData(data);
    if (active) renderFrame();
  },
};

window.SpaceView3D = SpaceView3D;

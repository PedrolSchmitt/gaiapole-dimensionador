import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const TEAL = 0x00c9b1;
const POLE_HEIGHT_M = 3.2; // ceiling height used for the pole cylinders — adjust here
const POLE_RADIUS_M = 0.035; // a bit thicker than a real 45mm pole so it reads at room scale
const WOOD_TILE_M = window.WOOD_TILE_M; // real-world size of one floor texture repeat, set in index.html

let container, renderer, labelRenderer, scene, camera, controls, dirLight;
let groundMesh, gridLines, roomGroup, poleGroup, woodTexture;
let shared = {};
let figures = [];
let rafId = null;
let active = false;
let lastData = null;
let framedKey = null;

// Floor canvas comes from the 2D plan (index.html) so both views share one floor.
function makeWoodTexture() {
  const tex = new THREE.CanvasTexture(window.getWoodCanvas());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function ensureScene() {
  if (scene) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
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

  // Soft studio reflections — this is what makes the chrome poles read as chrome.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c4a5, 0.35));
  dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.bias = -0.0004;
  dirLight.shadow.normalBias = 0.02;
  dirLight.shadow.radius = 4;
  scene.add(dirLight);
  scene.add(dirLight.target);

  woodTexture = makeWoodTexture();

  roomGroup = new THREE.Group();
  scene.add(roomGroup);
  poleGroup = new THREE.Group();
  scene.add(poleGroup);

  window.addEventListener('resize', resize);
  bindFigureDrag();
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

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  group.clear();
}

// 1m measuring grid clipped to the room, plus a teal outline of the room edge.
function buildGrid(roomW, roomH) {
  const pts = [];
  for (let x = 1; x < roomW; x++) pts.push(x, 0, 0, x, 0, roomH);
  for (let z = 1; z < roomH; z++) pts.push(0, 0, z, roomW, 0, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5a3a1c, transparent: true, opacity: 0.18 }));
  lines.position.y = 0.003;

  const outlineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(roomW, 0, 0),
    new THREE.Vector3(roomW, 0, roomH), new THREE.Vector3(0, 0, roomH),
  ]);
  const outline = new THREE.LineLoop(outlineGeo, new THREE.LineBasicMaterial({ color: TEAL }));
  outline.position.y = 0.004;
  lines.add(outline);
  return lines;
}

// Walls face inward with front-side-only rendering, so whichever walls sit
// between the camera and the room are culled and never block the view.
function buildWalls(roomW, roomH) {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf3efe9, roughness: 0.95 });
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const SKIRT_H = 0.1;
  const walls = [
    { len: roomW, pos: [roomW / 2, 0, 0], rotY: 0 },
    { len: roomW, pos: [roomW / 2, 0, roomH], rotY: Math.PI },
    { len: roomH, pos: [0, 0, roomH / 2], rotY: Math.PI / 2 },
    { len: roomH, pos: [roomW, 0, roomH / 2], rotY: -Math.PI / 2 },
  ];
  walls.forEach(function(w) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(w.len, POLE_HEIGHT_M), wallMat);
    wall.position.set(w.pos[0], POLE_HEIGHT_M / 2, w.pos[2]);
    wall.rotation.y = w.rotY;
    wall.receiveShadow = true;
    roomGroup.add(wall);

    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(w.len, SKIRT_H), skirtMat);
    skirt.rotation.y = w.rotY;
    skirt.position.set(w.pos[0], SKIRT_H / 2, w.pos[2]);
    skirt.translateZ(0.008);
    roomGroup.add(skirt);
  });
}

// Rebuilds the floor + re-frames the camera only when room dimensions actually
// change, so tweaking pole count / spacing doesn't reset the user's orbit view.
function syncGround(roomW, roomH) {
  const key = roomW + 'x' + roomH;
  if (key === framedKey) return;
  framedKey = key;

  disposeGroup(roomGroup);

  woodTexture.repeat.set(roomW / WOOD_TILE_M, roomH / WOOD_TILE_M);
  const groundMat = new THREE.MeshStandardMaterial({ map: woodTexture, roughness: 0.55, metalness: 0, envMapIntensity: 0.35 });
  groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomH), groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.set(roomW / 2, 0, roomH / 2);
  groundMesh.receiveShadow = true;
  roomGroup.add(groundMesh);

  gridLines = buildGrid(roomW, roomH);
  roomGroup.add(gridLines);
  buildWalls(roomW, roomH);

  const dist = Math.max(roomW, roomH);
  // Low-ish angle so the poles throw long, readable shadows across the floor.
  dirLight.position.set(roomW / 2 - dist * 0.9, POLE_HEIGHT_M + dist * 0.6, roomH / 2 - dist * 0.5);
  dirLight.target.position.set(roomW / 2, 0, roomH / 2);
  const cam = dirLight.shadow.camera;
  const half = dist * 0.75 + 1;
  cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
  cam.near = 0.5; cam.far = dist * 3 + 20;
  cam.updateProjectionMatrix();

  controls.target.set(roomW / 2, 0, roomH / 2);
  camera.position.set(roomW / 2 + dist * 0.6, dist * 0.65 + 2.5, roomH / 2 + dist * 0.9);
  controls.update();
}

function disposeShared() {
  Object.values(shared).forEach(r => r && r.dispose());
  shared = {};
}

// Standing figure built from primitives, same pose as the 2D plan: one hand on
// the pole at shoulder height, arms fully open. Origin is the body centre on the
// floor, local +x points away from the pole and -z is where she faces.
function buildFigureTemplate() {
  const C = window.FIGURE_COLORS;
  const half = window.ARM_SPAN_M / 2;
  const mat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.65 });
  shared.skinMat = mat(C.skin);
  shared.topMat = mat(C.top);
  shared.shortsMat = mat(C.shorts);
  shared.hairMat = mat(C.hair);
  shared.legGeo = new THREE.CapsuleGeometry(0.062, 0.72, 6, 16);
  shared.footGeo = new THREE.CapsuleGeometry(0.04, 0.14, 4, 10);
  shared.hipGeo = new THREE.CapsuleGeometry(0.15, 0.06, 6, 20);
  shared.torsoGeo = new THREE.CapsuleGeometry(0.15, 0.3, 8, 20);
  shared.neckGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.1, 12);
  shared.headGeo = new THREE.SphereGeometry(0.1, 24, 18);
  shared.hairGeo = new THREE.SphereGeometry(0.106, 24, 18);
  shared.bunGeo = new THREE.SphereGeometry(0.048, 16, 12);
  shared.handGeo = new THREE.SphereGeometry(0.045, 14, 10);

  const fig = new THREE.Group();
  function add(geo, m, x, y, z, setup) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    if (setup) setup(mesh);
    fig.add(mesh);
    return mesh;
  }

  [-1, 1].forEach(function(s) {
    add(shared.legGeo, shared.skinMat, s * 0.085, 0.48, 0);
    add(shared.footGeo, shared.skinMat, s * 0.09, 0.04, -0.06, m => { m.rotation.x = Math.PI / 2; m.rotation.y = s * 0.18; });
  });
  add(shared.hipGeo, shared.shortsMat, 0, 0.9, 0, m => { m.rotation.z = Math.PI / 2; m.scale.set(1, 1.1, 0.75); });
  add(shared.torsoGeo, shared.topMat, 0, 1.2, 0, m => m.scale.set(1.2, 1, 0.68));
  add(shared.neckGeo, shared.skinMat, 0, 1.49, 0);
  add(shared.headGeo, shared.skinMat, 0, 1.62, 0, m => m.scale.set(0.92, 1.1, 1));
  add(shared.hairGeo, shared.hairMat, 0, 1.64, 0.022, m => m.scale.set(0.95, 1.08, 1));
  add(shared.bunGeo, shared.hairMat, 0, 1.68, 0.13);

  // Arms: the pole-side hand stops at the tube surface, the other at full reach
  const SHOULDER_Y = 1.4, SHOULDER_X = 0.19, HAND_R = 0.045;
  const handL = -half + POLE_RADIUS_M + HAND_R, handR = half - HAND_R;
  [[-SHOULDER_X, handL], [SHOULDER_X, handR]].forEach(function(a) {
    const len = Math.abs(a[1] - a[0]);
    const geo = new THREE.CapsuleGeometry(0.042, len, 6, 12);
    shared['armGeo' + a[0]] = geo;
    add(geo, shared.skinMat, (a[0] + a[1]) / 2, SHOULDER_Y, 0, m => { m.rotation.z = Math.PI / 2; });
    add(shared.handGeo, shared.skinMat, a[1], SHOULDER_Y, 0, m => m.scale.set(1.3, 0.8, 1));
  });
  return fig;
}

// The angle lives on the pole object shared with the 2D plan (index.html).
// 2D canvas y is 3D z, so a canvas rotation of a is a rotation of -a about y.
function placeFigure(figure, pole) {
  const a = window.figureAngle(pole), half = window.ARM_SPAN_M / 2;
  figure.position.set(pole.x + Math.cos(a) * half, 0, pole.y + Math.sin(a) * half);
  figure.rotation.y = -a;
}

// Grab a figure and drag to swing it around its pole. Listens in the capture
// phase on the container so it can switch orbiting off before OrbitControls
// sees the pointerdown.
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const shoulderPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.4);
const planeHit = new THREE.Vector3();
let figureDrag = null;

function setPointer(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
}

function figureUnderPointer(e) {
  setPointer(e);
  const hits = raycaster.intersectObjects(figures.map(f => f.group), true);
  if (!hits.length) return null;
  return figures.find(f => f.group === hits[0].object.parent) || null;
}

function bindFigureDrag() {
  container.addEventListener('pointerdown', function(e) {
    const f = figureUnderPointer(e);
    if (!f) return;
    figureDrag = f;
    controls.enabled = false;
    renderer.domElement.style.cursor = 'grabbing';
  }, true);

  window.addEventListener('pointermove', function(e) {
    if (!active) return;
    if (!figureDrag) {
      if (e.target === renderer.domElement) renderer.domElement.style.cursor = figureUnderPointer(e) ? 'grab' : '';
      return;
    }
    setPointer(e);
    if (!raycaster.ray.intersectPlane(shoulderPlane, planeHit)) return;
    const p = figureDrag.pole;
    p.figAngle = Math.atan2(planeHit.z - p.y, planeHit.x - p.x);
    placeFigure(figureDrag.group, p);
  });

  window.addEventListener('pointerup', function() {
    if (!figureDrag) return;
    figureDrag = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = '';
    if (window.render) window.render(); // sync the 2D plan
  });
}

function rebuildPoles(poles, radiusM) {
  poleGroup.children.forEach(child => { if (child.isCSS2DObject) child.element.remove(); });
  poleGroup.clear();
  disposeShared();

  const r = Math.max(radiusM, 0.01);
  shared.poleGeo = new THREE.CylinderGeometry(POLE_RADIUS_M, POLE_RADIUS_M, POLE_HEIGHT_M, 32);
  shared.chromeMat = new THREE.MeshStandardMaterial({ color: 0xb4bac0, metalness: 1, roughness: 0.22 });
  shared.baseGeo = new THREE.CylinderGeometry(0.065, 0.08, 0.025, 40);
  shared.baseMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.5, roughness: 0.35 });
  shared.mountGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 32);
  shared.discGeo = new THREE.CircleGeometry(r, 64);
  shared.discMat = new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.14, depthWrite: false });
  shared.ringGeo = new THREE.RingGeometry(Math.max(r - 0.02, 0), r, 64);
  shared.ringMat = new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.55, depthWrite: false });
  const figureTemplate = buildFigureTemplate();
  figures = [];

  poles.forEach(function(p) {
    const x = p.x, z = p.y; // room's 2D y (depth) maps to 3D's z axis

    const pole = new THREE.Mesh(shared.poleGeo, shared.chromeMat);
    pole.position.set(x, POLE_HEIGHT_M / 2, z);
    pole.castShadow = true;
    poleGroup.add(pole);

    const base = new THREE.Mesh(shared.baseGeo, shared.baseMat);
    base.position.set(x, 0.0125, z);
    base.castShadow = true;
    poleGroup.add(base);

    const mount = new THREE.Mesh(shared.mountGeo, shared.chromeMat);
    mount.position.set(x, POLE_HEIGHT_M - 0.02, z);
    poleGroup.add(mount);

    const disc = new THREE.Mesh(shared.discGeo, shared.discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.005, z);
    poleGroup.add(disc);

    const ring = new THREE.Mesh(shared.ringGeo, shared.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.006, z);
    poleGroup.add(ring);

    const figure = figureTemplate.clone();
    placeFigure(figure, p);
    poleGroup.add(figure);
    figures.push({ group: figure, pole: p });

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

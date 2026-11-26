import * as THREE from "../../node_modules/three/build/three.module.js";

export function mountRoom3D(canvas, episodeID, solved) {
  const width = 730;
  const height = 400;
  canvas.width = width;
  canvas.height = height;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x09121a, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 50);

  const dark = 0x1a2938;
  const steel = 0x425766;
  const amber = 0xff9633;
  const turquoise = 0x38e0cf;
  const violet = 0x9680ff;
  const green = 0x54f28c;

  let accent = violet;
  if (episodeID === 1 || episodeID === 4) accent = amber;
  else if (episodeID === 2 || episodeID === 6) accent = turquoise;
  else if (episodeID === 7) accent = solved ? green : amber;

  function addBox(size, pos, color, lit = true) {
    const geom = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const mat = lit
      ? new THREE.MeshStandardMaterial({ color, roughness: 0.56, metalness: 0.75 })
      : new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    scene.add(mesh);
  }

  addBox([7, 0.12, 7], [0, -0.08, 0], dark);
  for (let stripe = -4; stripe <= 4; stripe++) {
    addBox([0.016, 0.016, 6.6], [stripe * 0.62, 0, 0], steel);
  }

  for (let rack = -1; rack <= 1; rack++) {
    const x = rack * 1.24;
    const z = rack === 0 ? -0.36 : -0.65;
    const rackColor = rack === 0 ? accent : steel;
    addBox([1.02, 2.25, 0.87], [x, 1.13, z], dark);
    for (const flank of [-1, 1]) {
      addBox([0.07, 2.2, 0.08], [x + flank * 0.46, 1.13, z + 0.47], rackColor);
    }
    for (let unit = 0; unit < 9; unit++) {
      const y = unit * 0.21 + 0.3;
      addBox([0.83, 0.16, 0.09], [x, y, z + 0.44], steel);
      addBox([0.38, 0.045, 0.1], [x - 0.12, y, z + 0.46], dark);
      for (let led = 0; led < 3; led++) {
        const color = unit % 4 === 0 ? amber : turquoise;
        addBox([0.025, 0.023, 0.025], [x + 0.21 + led * 0.06, y, z + 0.51], color, false);
      }
    }
  }

  if (episodeID === 2 || episodeID === 4) {
    const paper = 0xe6d480;
    addBox([0.37, 0.29, 0.023], [0.35, 1.57, 0.24], paper, false);
    for (let line = 0; line < 3; line++) {
      addBox([0.25, 0.013, 0.015], [0.35, 1.62 - line * 0.05, 0.26], dark, false);
    }
  } else if (episodeID === 6) {
    addBox([1.75, 0.1, 0.62], [0, 0.84, 0.92], steel);
    for (const x of [-0.45, 0.45]) {
      addBox([0.54, 0.35, 0.18], [x, 1.07, 0.98], dark);
      addBox([0.43, 0.24, 0.02], [x, 1.07, 1.08], x < 0 ? amber : turquoise, false);
    }
  } else {
    const x = episodeID === 1 ? 0 : 0.76;
    addBox([0.71, 0.41, 0.07], [x, 1.13, 0.48], dark);
    addBox([0.63, 0.33, 0.025], [x, 1.13, 0.53], accent, false);
    for (let row = 0; row < 4; row++) {
      addBox(
        [0.48 - (row % 2) * 0.16, 0.023, 0.02],
        [x - 0.035, 1.23 - row * 0.065, 0.55],
        dark,
        false
      );
    }
    if (episodeID === 5 || episodeID === 7) {
      addBox([0.62, 0.07, 0.4], [x, 0.65, 0.72], steel);
      addBox([0.08, 0.05, 0.04], [x + 0.25, 0.68, 0.93], accent, false);
    }
  }

  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);

  const keyLight = new THREE.PointLight(0xffffff, 28, 12);
  keyLight.position.set(1.5, 3.25, 2.5);
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(accent, 14, 10);
  fillLight.position.set(-2.2, 1.75, 0.8);
  scene.add(fillLight);

  function setRotation(deg) {
    const rad = (deg * Math.PI) / 180;
    camera.position.set(Math.sin(rad) * 5.2, 2.25, Math.cos(rad) * 5.2);
    camera.lookAt(0, 1.12, 0);
    renderer.render(scene, camera);
  }

  setRotation(12);

  return {
    setRotation,
    dispose() {
      renderer.dispose();
    },
  };
}

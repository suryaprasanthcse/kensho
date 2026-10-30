// Runs inside headless Chromium. Loads a verified bundle into a minimal scene and records probes.
// Plain JavaScript on purpose: it is served as-is next to three's own files, with no bundler.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const params = new URLSearchParams(location.search);
const hooks = new Set((params.get('hooks') || '').split(',').filter(Boolean));
const FRAMES = Number(params.get('frames') || '6');
const W = 640;
const H = 360;

const probe = { shaderErrors: [], glErrors: [], contextLost: 0, contextRestored: 0, loadErrors: [], compileError: null };
let ready = false;
window.__kensho = { done: false, result: null };

// Every non-zero value any caller reads from getError is recorded.
const nativeGetError = WebGL2RenderingContext.prototype.getError;
WebGL2RenderingContext.prototype.getError = function () {
  const e = nativeGetError.call(this);
  if (e !== 0) probe.glErrors.push(e);
  return e;
};
const drain = (gl) => {
  for (let i = 0; i < 32; i++) if (gl.getError() === 0) break;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const MICRO = 1e-6;

function textureBytes(scene) {
  const seen = new Set();
  let bytes = 0;
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) {
        const t = m[k];
        if (t && t.isTexture && !seen.has(t) && t.image && t.image.width && t.image.height) {
          seen.add(t);
          bytes += Math.ceil((t.image.width * t.image.height * 16) / 3);
        }
      }
    }
  });
  return { bytes, count: seen.size };
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    probe.contextLost++;
  });
  canvas.addEventListener('webglcontextrestored', () => probe.contextRestored++);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x202830, 1);
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    probe.shaderErrors.push({
      program: String(gl.getProgramInfoLog(program) || '').slice(0, 200),
      vertex: String(gl.getShaderInfoLog(vs) || '').slice(0, 200),
      fragment: String(gl.getShaderInfoLog(fs) || '').slice(0, 200),
    });
  };
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererString = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));

  ready = true;
  const manifest = await (await fetch('/bundle/manifest.json')).json();
  const loader = new GLTFLoader();
  const loaded = new Map();
  await Promise.all(
    manifest.assets.map(async (a) => {
      try {
        const gltf = await loader.loadAsync('/bundle/' + a.path);
        loaded.set(a.id, gltf.scene);
      } catch (e) {
        probe.loadErrors.push(a.id + ': ' + String((e && e.message) || e).slice(0, 160));
      }
    }),
  );

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 8, 5);
  scene.add(sun);
  for (const p of manifest.placements) {
    const src = loaded.get(p.asset);
    if (!src) continue;
    const obj = src.clone(true);
    obj.position.set(p.translation_um[0] * MICRO, p.translation_um[1] * MICRO, p.translation_um[2] * MICRO);
    obj.quaternion.set(p.rotation_uq[0] * MICRO, p.rotation_uq[1] * MICRO, p.rotation_uq[2] * MICRO, p.rotation_uq[3] * MICRO).normalize();
    obj.scale.set(p.scale_ppm[0] * MICRO, p.scale_ppm[1] * MICRO, p.scale_ppm[2] * MICRO);
    scene.add(obj);
  }

  if (hooks.has('many_programs')) {
    // test hook: sixty meshes whose materials each need their own shader program
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    for (let i = 0; i < 60; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0x88aa66 });
      m.onBeforeCompile = (s) => {
        s.fragmentShader = '#define KENSHO_VARIANT ' + i + '\n' + s.fragmentShader;
      };
      m.customProgramCacheKey = () => 'kensho-variant-' + i;
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(i * 0.12 - 3.5, 0.05, 0);
      scene.add(mesh);
    }
  }
  if (hooks.has('bad_shader')) {
    // test hook: an invalid GLSL chunk in every material
    scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        m.onBeforeCompile = (s) => {
          s.fragmentShader = s.fragmentShader.replace('#include <dithering_fragment>', 'THIS_IS_NOT_GLSL(;\n#include <dithering_fragment>');
        };
        m.customProgramCacheKey = () => 'kensho-broken';
        m.needsUpdate = true;
      }
    });
  }

  const cam = manifest.camera;
  const camera = new THREE.PerspectiveCamera(cam ? cam.fov_urad * MICRO * (180 / Math.PI) : 50, W / H, 0.05, 500);
  if (cam) {
    camera.position.set(cam.position_um[0] * MICRO, cam.position_um[1] * MICRO, cam.position_um[2] * MICRO);
    camera.lookAt(cam.look_at_um[0] * MICRO, cam.look_at_um[1] * MICRO, cam.look_at_um[2] * MICRO);
  } else {
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const dist = (size.length() / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.3 + 0.5;
    camera.position.set(centre.x, centre.y + size.y * 0.3, centre.z + dist);
    camera.lookAt(centre);
  }

  try {
    await renderer.compileAsync(scene, camera);
  } catch (e) {
    probe.compileError = String((e && e.message) || e).slice(0, 160);
  }
  drain(gl);

  let framesRendered = 0;
  for (let i = 0; i < FRAMES; i++) {
    renderer.render(scene, camera);
    drain(gl);
    framesRendered++;
    await tick();
  }

  const info = renderer.info;
  const tex = textureBytes(scene);
  const pixels = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  drain(gl);
  const view = new Uint32Array(pixels.buffer);
  const colours = new Set();
  for (let i = 0; i < view.length && colours.size < 4096; i++) colours.add(view[i]);
  const frameSha = await sha256Hex(pixels);

  const result = {
    renderer: rendererString,
    framesRendered,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs ? info.programs.length : 0,
    textures: tex.count,
    textureBytes: tex.bytes,
    frame: { sha256: frameSha, distinctColours: colours.size },
  };

  if (hooks.has('gl_error')) {
    gl.bindTexture(0xffff, null); // invalid target: INVALID_ENUM
    drain(gl);
  }
  if (hooks.has('lose_context')) {
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    await new Promise((r) => setTimeout(r, 200));
  }
  if (hooks.has('page_exception')) {
    setTimeout(() => {
      throw new Error('kensho test hook: uncaught exception');
    }, 0);
    await new Promise((r) => setTimeout(r, 100));
  }

  return { ...result, shaderErrors: probe.shaderErrors, glErrors: probe.glErrors, contextLost: probe.contextLost, contextRestored: probe.contextRestored, loadErrors: probe.loadErrors, compileError: probe.compileError };
}

main()
  .then((result) => {
    window.__kensho.result = result;
    window.__kensho.done = true;
  })
  .catch((e) => {
    window.__kensho.result = { fatal: String((e && e.stack) || e).slice(0, 500), ready };
    window.__kensho.done = true;
  });

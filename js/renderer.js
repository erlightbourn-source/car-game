/*
 * renderer.js — TRUE 3D renderer (Three.js / WebGL).
 *
 * The pure game logic in engine.js is renderer-agnostic: it tracks lanes and
 * an abstract depth `z` per obstacle/coin. This renderer maps that abstract
 * world into a real 3D scene with perspective, PBR materials, dynamic shadows,
 * reflections (image-based lighting), volumetric-style fog and a sky dome.
 *
 * It exposes the SAME interface the old 2D renderer did
 * (constructor, resize, render, setCar, burst, camShift) so nothing else in
 * the project had to change.
 *
 * Coordinate mapping (engine → 3D world, metres):
 *   worldX = laneFrac * LANE_W
 *   worldZ = -((engine_z - PLAYER_Z) * DEPTH)   // ahead of the camera is -Z
 *   The camera sits behind/above the player car looking down the road.
 */
class Renderer {
  constructor(canvas, cfg) {
    this.cfg = cfg;
    this.canvas = canvas;
    this.camShift = 0;                 // kept for API compatibility (unused in 3D)
    this.carColors = { body: "#ff5b6e", roof: "#ff7286", bumper: "#e8485b" };
    this.carDesign = "hatch";          // current body shape
    this.lightDef = LIGHTS[0];         // current taillight colour

    // --- World scale ---
    this.LANE_W = 3.05;                // metres between lane centres ≈ 2*0.62 mapping below
    this.DEPTH = 0.95;                 // metres per engine depth unit
    this.ROAD_HALF = 5.6;             // half-width of asphalt (metres)

    this._initThree();
    this._buildEnvironment();
    this._buildRoad();
    this._buildCar();
    this._pools = {};                  // reusable meshes by kind
    this._scenery = { tree: [], lamp: [] };
    this._particles = [];
    this._particleGeo = new THREE.PlaneGeometry(0.45, 0.45);
    this.t = 0;
  }

  // engine depth -> world Z
  _wz(z) { return -((z - this.cfg.PLAYER_Z) * this.DEPTH); }
  // engine lane fraction (±0.62 = outer lanes) -> world X (metres), kept inside the road
  _wx(frac) { return (frac / 0.62) * 3.72; }

  _initThree() {
    // Detect phones/tablets so we can run a lighter, more robust path on GPUs
    // that choke on heavy multi-pass rendering (a common source of mobile crashes).
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    this.isMobile = coarse || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");

    let r;
    try {
      r = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: !this.isMobile,        // MSAA is costly on mobile GPUs
        alpha: false,
        powerPreference: "high-performance",
        failIfMajorPerformanceCaveat: false,
      });
    } catch (e) {
      const err = new Error("WEBGL_INIT_FAILED"); err.detail = e; throw err;
    }
    if (!r || !r.getContext()) throw new Error("WEBGL_UNSUPPORTED");

    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.5 : 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = this.isMobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    r.outputEncoding = THREE.sRGBEncoding;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.86;
    this.r = r;

    // Recover gracefully if a mobile GPU drops the WebGL context (otherwise
    // the browser shows a hard "WebGL error" and the page appears broken).
    this._contextLost = false;
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this._contextLost = true; }, false);
    this.canvas.addEventListener("webglcontextrestored", () => { window.location.reload(); }, false);

    this.scene = new THREE.Scene();
    this.fogColor = new THREE.Color(0x9fc8e6);
    // Tuned so obstacles/coins spawning near the horizon emerge from the haze
    // instead of popping into existence mid-road.
    this.scene.fog = new THREE.Fog(this.fogColor, 48, 195);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 700);
    this.camera.position.set(0, 3.5, 9.6);
    this.camLook = new THREE.Vector3(0, 0.85, -26);
    this.camera.lookAt(this.camLook);

    // Cinematic bloom — DESKTOP ONLY. The multi-pass float composer is the most
    // fragile/expensive thing on phones, so mobile uses the fast direct path.
    this.composer = null;
    if (!this.isMobile) {
      try {
        if (THREE.EffectComposer && THREE.UnrealBloomPass) {
          const composer = new THREE.EffectComposer(r);
          composer.addPass(new THREE.RenderPass(this.scene, this.camera));
          const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.82);
          this.bloom = bloom;
          composer.addPass(bloom);
          composer.addPass(new THREE.ShaderPass(THREE.GammaCorrectionShader)); // linear → sRGB
          this.composer = composer;
        }
      } catch (e) { this.composer = null; }
    }
  }

  _buildEnvironment() {
    const scene = this.scene;

    // Sky dome (vertical gradient shader) ----------------------------------
    const skyGeo = new THREE.SphereGeometry(500, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x2f86d8) },
        mid: { value: new THREE.Color(0x8fc6f0) },
        bot: { value: new THREE.Color(0xd7eef8) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vP;
        void main(){ float h = normalize(vP).y; vec3 c = h>0.0 ? mix(mid,top,pow(h,0.55)) : mix(mid,bot,pow(-h,0.5)); gl_FragColor=vec4(c,1.0);} `,
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));
    this.skyMat = skyMat;

    // Sun disc + glow sprite
    const sunDir = new THREE.Vector3(-0.45, 0.55, -0.7).normalize();
    const sunPos = sunDir.clone().multiplyScalar(380);
    const glow = this._radialSprite("#fff6c6", 1.0);
    glow.scale.set(120, 120, 1);
    glow.position.copy(sunPos);
    scene.add(glow);
    this.sunGlow = glow;

    // Image-based lighting JUST for shiny surfaces (car paint, glass, coins).
    // Not assigned as scene.environment so it doesn't flood matte surfaces.
    const pmrem = new THREE.PMREMGenerator(this.r);
    const eqTex = new THREE.CanvasTexture(this._gradientCanvas());
    eqTex.mapping = THREE.EquirectangularReflectionMapping;
    this.envTex = pmrem.fromEquirectangular(eqTex).texture;
    eqTex.dispose();

    // Lights ----------------------------------------------------------------
    const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x4c6b38, 0.5);
    scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(0xfff1cf, 2.5);
    sun.position.copy(sunPos.clone().setLength(60));
    this.sun = sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.isMobile ? 1024 : 2048, this.isMobile ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22;
    sc.near = 1; sc.far = 160;
    sun.shadow.bias = -0.0004;
    sun.target.position.set(0, 0, -22);
    scene.add(sun); scene.add(sun.target);

    // Grass ground ----------------------------------------------------------
    const grassTex = new THREE.CanvasTexture(this._grassCanvas());
    grassTex.encoding = THREE.sRGBEncoding;
    grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(60, 200);
    this.grassTex = grassTex;
    // Neutral-tinted base so the background theme can colour the field (green,
    // sand, snow…) via the material colour.
    const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, bumpMap: grassTex, bumpScale: 0.06, roughness: 1, metalness: 0, color: 0x6bbf4f });
    this.grassMat = grassMat;
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(600, 800), grassMat);
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(0, -0.02, -200);
    grass.receiveShadow = true;
    scene.add(grass);
  }

  // Apply a background theme (sky / fog / sun / ambient / grass tint).
  setBackground(bg) {
    if (!bg) return;
    this.skyMat.uniforms.top.value.set(bg.sky[0]);
    this.skyMat.uniforms.mid.value.set(bg.sky[1]);
    this.skyMat.uniforms.bot.value.set(bg.sky[2]);
    this.fogColor.set(bg.fog);
    this.scene.fog.color.set(bg.fog);
    this.scene.fog.near = bg.fogNear; this.scene.fog.far = bg.fogFar;
    this.hemi.color.set(bg.hemiSky);
    this.hemi.groundColor.set(bg.hemiGround);
    this.hemi.intensity = bg.hemiInt;
    this.sun.color.set(bg.sun);
    this.sun.intensity = bg.sunInt;
    const dir = new THREE.Vector3(bg.sunDir[0], bg.sunDir[1], bg.sunDir[2]).normalize();
    this.sun.position.copy(dir.clone().multiplyScalar(60));
    this.sunGlow.position.copy(dir.clone().multiplyScalar(380));
    this.sunGlow.material.color.set(bg.glow);
    this.grassMat.color.set(bg.grass).convertSRGBToLinear();
  }

  _buildRoad() {
    const roadTex = new THREE.CanvasTexture(this._roadCanvas());
    roadTex.encoding = THREE.sRGBEncoding;
    roadTex.wrapS = roadTex.wrapT = THREE.RepeatWrapping;
    roadTex.anisotropy = this.r.capabilities.getMaxAnisotropy();
    roadTex.repeat.set(1, 90);
    this.roadTex = roadTex;
    this.roadRepeat = 90;
    this.roadLen = 760;

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(this.ROAD_HALF * 2 + 0.6, this.roadLen),
      new THREE.MeshStandardMaterial({ map: roadTex, bumpMap: roadTex, bumpScale: 0.015, roughness: 0.85, metalness: 0.0 })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -this.roadLen / 2 + 8);
    road.receiveShadow = true;
    this.scene.add(road);

    // soft dirt shoulders
    for (const side of [-1, 1]) {
      const sh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, this.roadLen),
        new THREE.MeshStandardMaterial({ color: 0x7a6a4f, roughness: 1 })
      );
      sh.rotation.x = -Math.PI / 2;
      sh.position.set(side * (this.ROAD_HALF + 0.7), -0.01, -this.roadLen / 2 + 8);
      sh.receiveShadow = true;
      this.scene.add(sh);
    }
  }

  // ---- Car model ----------------------------------------------------------
  _buildCar() {
    const g = new THREE.Group();
    this.carParts = {};

    const bodyMat = new THREE.MeshStandardMaterial({ color: this.carColors.body, metalness: 0.4, roughness: 0.38, envMap: this.envTex, envMapIntensity: 0.5 });
    bodyMat.color.convertSRGBToLinear();
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0e151c, metalness: 0.9, roughness: 0.08, envMap: this.envTex, envMapIntensity: 0.95 });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x111317, metalness: 0.1, roughness: 0.85 });
    const tailMat = new THREE.MeshStandardMaterial({ color: this.lightDef.color, emissive: this.lightDef.emissive, emissiveIntensity: 1.4, roughness: 0.4 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.5, roughness: 0.5 });
    this.carParts.bodyMat = bodyMat;
    this.tailMat = tailMat;

    // Design-specific painted body + glass greenhouse.
    this._buildBody(this.carDesign, bodyMat, glassMat, trimMat, g);

    // ---- Shared parts (same footprint for every design) ----
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 0.2), trimMat);
    bumper.position.set(0, 0.4, 1.98); g.add(bumper);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
    plate.position.set(0, 0.62, 2.0); g.add(plate);

    // Wheels: geometry baked so the axle runs along X; spin via rotation.x to roll.
    const tyreGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 20); tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.36, 14); rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xcfd3da, metalness: 0.8, roughness: 0.35, envMap: this.envTex });
    this.wheels = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const wg = new THREE.Group();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat); tyre.castShadow = true; wg.add(tyre);
      const rim = new THREE.Mesh(rimGeo, rimMat); rim.position.x = sx * 0.02; wg.add(rim);
      wg.position.set(sx * 1.02, 0.4, sz * 1.25);
      g.add(wg);
      this.wheels.push(wg);
    }

    // Side mirrors
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.08), bodyMat);
      arm.position.set(sx * 1.02, 1.0, -0.95); g.add(arm);
      const glassM = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.22), glassMat);
      glassM.position.set(sx * 1.14, 1.0, -0.95); g.add(glassM);
    }

    // Taillights (colour customizable) — just proud of the rear surface.
    const tlGeo = new THREE.BoxGeometry(0.42, 0.18, 0.06);
    for (const sx of [-1, 1]) {
      const tl = new THREE.Mesh(tlGeo, tailMat);
      tl.position.set(sx * 0.72, 0.62, 2.04);
      g.add(tl);
    }
    const hlMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 0.8 });
    for (const sx of [-1, 1]) {
      const hl = new THREE.Mesh(tlGeo, hlMat);
      hl.position.set(sx * 0.72, 0.6, -2.04);
      g.add(hl);
    }

    g.position.set(0, 0, 0);
    this.car = g;
    this.scene.add(g);
  }

  // Extrude a side-profile shape (x = length) along width, bevel it, and rotate
  // so the car's length runs along world Z.
  _profileMesh(shape, depth, bevel, mat) {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, steps: 1 });
    geo.translate(0, 0, -depth / 2);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = -Math.PI / 2; m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  _buildBody(design, bodyMat, glassMat, trimMat, g) {
    if (design === "pickup") {
      // Boxy truck: chassis + cab (front) + open bed (rear) with walls & tailgate.
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.4, 3.9), bodyMat);
      chassis.position.set(0, 0.5, 0.0); chassis.castShadow = true; g.add(chassis);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.54, 1.5), bodyMat);
      cab.position.set(0, 0.97, -0.75); cab.castShadow = true; g.add(cab);
      const cabGlass = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.42, 1.24), glassMat);
      cabGlass.position.set(0, 1.0, -0.72); g.add(cabGlass);
      for (const sx of [-1, 1]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 1.7), bodyMat);
        wall.position.set(sx * 0.94, 0.87, 0.95); wall.castShadow = true; g.add(wall);
      }
      const tail = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.34, 0.12), bodyMat);
      tail.position.set(0, 0.87, 1.78); tail.castShadow = true; g.add(tail);
      return;
    }

    const lb = new THREE.Shape(), gh = new THREE.Shape();

    if (design === "sport") {
      lb.moveTo(-2.0, 0.26); lb.lineTo(-2.0, 0.46);
      lb.quadraticCurveTo(-1.9, 0.58, -1.4, 0.62); lb.lineTo(1.5, 0.62);
      lb.quadraticCurveTo(1.92, 0.58, 2.0, 0.46); lb.lineTo(2.0, 0.26); lb.closePath();
      gh.moveTo(-0.55, 0.58);
      gh.quadraticCurveTo(-0.2, 0.66, 0.05, 1.12);
      gh.quadraticCurveTo(0.12, 1.18, 0.5, 1.18);
      gh.quadraticCurveTo(0.95, 1.16, 1.2, 0.66);
      gh.lineTo(1.25, 0.58); gh.closePath();
      g.add(this._profileMesh(lb, 2.0, 0.10, bodyMat));
      g.add(this._profileMesh(gh, 1.5, 0.05, glassMat));
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.4), bodyMat);
      wing.position.set(0, 0.98, 1.5); g.add(wing);
      for (const sx of [-1, 1]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.12), bodyMat);
        st.position.set(sx * 0.5, 0.86, 1.5); g.add(st);
      }
      return;
    }

    if (design === "classic") {
      lb.moveTo(-1.7, 0.32);
      lb.quadraticCurveTo(-1.72, 0.62, -1.35, 0.70); lb.lineTo(1.35, 0.70);
      lb.quadraticCurveTo(1.72, 0.62, 1.7, 0.32); lb.closePath();
      gh.moveTo(-0.62, 0.68);
      gh.quadraticCurveTo(-0.4, 1.5, 0.0, 1.58);
      gh.quadraticCurveTo(0.42, 1.64, 0.72, 1.52);
      gh.quadraticCurveTo(1.0, 1.36, 1.02, 0.70);
      gh.lineTo(1.02, 0.68); gh.closePath();
      g.add(this._profileMesh(lb, 1.95, 0.16, bodyMat));
      g.add(this._profileMesh(gh, 1.55, 0.08, glassMat));
      return;
    }

    if (design === "van") {
      // Tall boxy van with a wraparound window band.
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 3.9), bodyMat);
      chassis.position.set(0, 0.55, 0); chassis.castShadow = true; g.add(chassis);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.96, 0.95, 3.4), bodyMat);
      cabin.position.set(0, 1.25, -0.1); cabin.castShadow = true; g.add(cabin);
      const band = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.4, 3.0), glassMat);
      band.position.set(0, 1.42, -0.15); g.add(band);
      return;
    }

    if (design === "roadster") {
      // Open-top convertible: low body, dark cockpit, small raked windshield, roll hoop.
      lb.moveTo(-2.0, 0.26); lb.lineTo(-2.0, 0.5);
      lb.quadraticCurveTo(-1.9, 0.64, -1.4, 0.68); lb.lineTo(1.5, 0.68);
      lb.quadraticCurveTo(1.92, 0.64, 2.0, 0.5); lb.lineTo(2.0, 0.26); lb.closePath();
      g.add(this._profileMesh(lb, 2.0, 0.12, bodyMat));
      const pit = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 1.7),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.85 }));
      pit.position.set(0, 0.62, 0.1); g.add(pit);
      const ws = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.06), glassMat);
      ws.position.set(0, 0.96, -0.55); ws.rotation.x = -0.55; g.add(ws);
      const hoop = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.32, 0.12), bodyMat);
      hoop.position.set(0, 0.96, 0.72); g.add(hoop);
      return;
    }

    // default: hatch
    lb.moveTo(-1.95, 0.30); lb.lineTo(-1.95, 0.52);
    lb.quadraticCurveTo(-1.86, 0.66, -1.45, 0.70); lb.lineTo(1.5, 0.70);
    lb.quadraticCurveTo(1.9, 0.66, 1.97, 0.52); lb.lineTo(1.97, 0.30); lb.closePath();
    gh.moveTo(-0.45, 0.66);
    gh.quadraticCurveTo(-0.18, 0.74, 0.02, 1.38);
    gh.quadraticCurveTo(0.10, 1.46, 0.55, 1.46);
    gh.quadraticCurveTo(0.98, 1.44, 1.26, 0.80);
    gh.lineTo(1.30, 0.66); gh.closePath();
    g.add(this._profileMesh(lb, 2.0, 0.10, bodyMat));
    g.add(this._profileMesh(gh, 1.5, 0.05, glassMat));
  }

  _rebuildCar() {
    if (this.car) {
      this.scene.remove(this.car);
      this.car.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { const m = o.material; (Array.isArray(m) ? m : [m]).forEach((mm) => mm.dispose && mm.dispose()); }
      });
    }
    this._buildCar();
  }

  setCar(colors) {
    this.carColors = colors;
    if (this.carParts && this.carParts.bodyMat) {
      this.carParts.bodyMat.color.set(colors.body).convertSRGBToLinear();
    }
  }

  setDesign(id) {
    if (id === this.carDesign) return;
    this.carDesign = id;
    this._rebuildCar();
  }

  setLights(def) {
    this.lightDef = def || LIGHTS[0];
    if (this.tailMat) {
      this.tailMat.color.set(this.lightDef.color);
      this.tailMat.emissive.set(this.lightDef.emissive);
    }
  }

  // ---- Mesh factories (pooled) -------------------------------------------
  _poolGet(kind, make) {
    if (!this._pools[kind]) this._pools[kind] = { items: [], used: 0 };
    const p = this._pools[kind];
    if (p.used >= p.items.length) {
      const m = make();
      this.scene.add(m);
      p.items.push(m);
    }
    const m = p.items[p.used++];
    m.visible = true;
    return m;
  }
  _poolResetAll() { for (const k in this._pools) this._pools[k].used = 0; }
  _poolHideUnused() {
    for (const k in this._pools) {
      const p = this._pools[k];
      for (let i = p.used; i < p.items.length; i++) p.items[i].visible = false;
    }
  }

  _makeCone() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6a25, roughness: 0.5, metalness: 0.05 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.5, 20), mat);
    body.position.y = 0.75; body.castShadow = true; g.add(body);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.46, 0.28, 20),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    band.position.y = 0.7; g.add(band);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 1.1), mat);
    base.position.y = 0.06; base.castShadow = true; g.add(base);
    return g;
  }
  _makeBarrier() {
    const g = new THREE.Group();
    const stripeTex = new THREE.CanvasTexture(this._stripeCanvas());
    const board = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.7, 0.16),
      new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.6 }));
    board.position.y = 1.25; board.castShadow = true; g.add(board);
    const legMat = new THREE.MeshStandardMaterial({ color: 0xb94b38, roughness: 0.7 });
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.6, 0.5), legMat);
      leg.position.set(sx * 1.2, 0.8, 0); leg.castShadow = true; g.add(leg);
    }
    return g;
  }
  _makePothole() {
    const m = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24),
      new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.95 }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.02;
    return m;
  }
  _makeIssueCar() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a7bd8, metalness: 0.4, roughness: 0.45 });
    const body = new THREE.Mesh(this._roundedBox(2.0, 0.7, 3.6, 0.22), mat);
    body.position.y = 0.6; body.castShadow = true; g.add(body);
    const cab = new THREE.Mesh(this._roundedBox(1.7, 0.62, 1.9, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xcfd9ff, metalness: 0.6, roughness: 0.1 }));
    cab.position.set(0, 1.05, 0.05); g.add(cab);
    const tail = new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2020, emissiveIntensity: 1.2 });
    for (const sx of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.06), tail);
      t.position.set(sx * 0.62, 0.66, 1.82); g.add(t);
    }
    return g;
  }
  _makeCoin() {
    // A group we spin around Y; the disc inside faces the camera at spin=0.
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 28),
      new THREE.MeshStandardMaterial({ color: 0xffc63a, metalness: 0.9, roughness: 0.25, emissive: 0x7a5600, emissiveIntensity: 0.35, envMap: this.envTex }));
    disc.rotation.x = Math.PI / 2;   // circular faces point ±Z (toward camera)
    disc.castShadow = true;
    g.add(disc);
    return g;
  }
  _makePower() {
    // A glowing gold star (the ×2 coin doubler). Emissive so bloom catches it.
    if (!this._starGeo) {
      const s = new THREE.Shape();
      const spikes = 5, outer = 0.62, inner = 0.27;
      for (let i = 0; i < spikes * 2; i++) {
        const r = (i % 2) ? inner : outer;
        const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
      }
      s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1, steps: 1 });
      g.center();
      this._starGeo = g;
    }
    const m = new THREE.Mesh(this._starGeo,
      new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffb000, emissiveIntensity: 1.4, metalness: 0.5, roughness: 0.3, envMap: this.envTex }));
    m.castShadow = true;
    return m;
  }
  _makeTree() {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 1.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x7a4a2b, roughness: 0.9 }));
    trunk.position.y = 0.7; trunk.castShadow = true; g.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f9e3f, roughness: 0.9 });
    const c1 = new THREE.Mesh(new THREE.SphereGeometry(1.0, 12, 10), leafMat);
    c1.position.y = 2.0; c1.castShadow = true; g.add(c1);
    const c2 = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), leafMat);
    c2.position.set(0.6, 1.6, 0.2); g.add(c2);
    const c3 = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), leafMat);
    c3.position.set(-0.6, 1.6, -0.2); g.add(c3);
    return g;
  }
  _makeLamp() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x7d838f, metalness: 0.6, roughness: 0.4 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.2, 10), mat);
    pole.position.y = 2.1; pole.castShadow = true; g.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.1), mat);
    arm.position.set(0.45, 4.1, 0); g.add(arm);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffdd80, emissiveIntensity: 1.0 }));
    bulb.position.set(0.9, 4.05, 0); g.add(bulb);
    return g;
  }

  // ---- Particles (3D, spawned at the car) --------------------------------
  burst(_x, _y, count, color) {
    if (!this.car) return;
    const base = this.car.position;
    const col = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this._particleGeo,
        new THREE.MeshBasicMaterial({ color: col, transparent: true, depthWrite: false }));
      m.position.set(base.x + (Math.random() - 0.5) * 1.5, 0.5 + Math.random() * 1.2, base.z + (Math.random() - 0.5) * 1.5);
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 3;
      m.userData = { vx: Math.cos(a) * sp, vy: 2 + Math.random() * 3, vz: Math.sin(a) * sp, life: 1 };
      this.scene.add(m);
      this._particles.push(m);
    }
  }
  _updateParticles(dt) {
    for (const m of this._particles) {
      const u = m.userData;
      m.position.x += u.vx * dt; m.position.y += u.vy * dt; m.position.z += u.vz * dt;
      u.vy -= 9 * dt; u.life -= dt * 1.6;
      m.material.opacity = Math.max(0, u.life);
      const s = 0.4 + (1 - u.life) * 0.6; m.scale.set(s, s, s);
      m.lookAt(this.camera.position);
    }
    this._particles = this._particles.filter((m) => {
      if (m.userData.life <= 0) { this.scene.remove(m); m.material.dispose(); return false; }
      return true;
    });
  }

  // ---- Procedural textures -----------------------------------------------
  _roadCanvas() {
    const W = 256, H = 1024, cv = document.createElement("canvas");
    cv.width = W; cv.height = H; const x = cv.getContext("2d");
    // asphalt base + grain
    x.fillStyle = "#34383f"; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 9000; i++) {
      const g = 40 + Math.random() * 45;
      x.fillStyle = `rgba(${g},${g},${g + 4},${0.06 + Math.random() * 0.14})`;
      x.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
    // edge lines
    x.fillStyle = "#e9e9e9";
    x.fillRect(W * 0.05, 0, 6, H); x.fillRect(W * 0.95 - 6, 0, 6, H);
    // lane divider dashes (two dividers for 3 lanes)
    x.fillStyle = "#ffe14a";
    for (const u of [W / 3, (2 * W) / 3]) {
      for (let y = 0; y < H; y += 120) x.fillRect(u - 4, y, 8, 64);
    }
    return cv;
  }
  _grassCanvas() {
    // Neutral grey base + grey speckle so the field can be tinted any colour
    // (green / sand / snow) by the background theme via material.color.
    const S = 128, cv = document.createElement("canvas");
    cv.width = S; cv.height = S; const x = cv.getContext("2d");
    x.fillStyle = "#d6d6d6"; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 1500; i++) {
      const g = 110 + Math.random() * 90;
      x.fillStyle = `rgba(${g},${g},${g},${0.12 + Math.random() * 0.22})`;
      x.fillRect(Math.random() * S, Math.random() * S, 2, 3);
    }
    return cv;
  }
  _stripeCanvas() {
    const W = 256, H = 64, cv = document.createElement("canvas");
    cv.width = W; cv.height = H; const x = cv.getContext("2d");
    for (let i = 0; i < 8; i++) {
      x.fillStyle = i % 2 ? "#fff3e6" : "#ff7a2f";
      x.save(); x.translate((i * W) / 8, 0); x.transform(1, 0, -0.7, 1, 0, 0);
      x.fillRect(0, 0, W / 8 + 30, H); x.restore();
    }
    return cv;
  }
  _gradientCanvas() {
    const W = 16, H = 128, cv = document.createElement("canvas");
    cv.width = W; cv.height = H; const x = cv.getContext("2d");
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#2f86d8"); g.addColorStop(0.5, "#bfe0f5");
    g.addColorStop(0.5, "#bfe0f5"); g.addColorStop(1, "#5fae46");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    return cv;
  }
  _radialSprite(color, opacity) {
    const S = 128, cv = document.createElement("canvas");
    cv.width = S; cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    g.addColorStop(0, color); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity, depthWrite: false, fog: false });
    return new THREE.Sprite(mat);
  }

  _roundedBox(w, h, d, r) {
    // BoxGeometry is fine for our cartoon-real look; r kept for call sites.
    return new THREE.BoxGeometry(w, h, d);
  }

  // Project the car to screen coordinates (viewport px) — used to launch the
  // coin-collect animation from the car toward the HUD.
  carScreenPos() {
    const v = new THREE.Vector3(this.car.position.x, 1.1, this.car.position.z);
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  // ---- Resize -------------------------------------------------------------
  resize() {
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.r.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // Widen the (vertical) FOV on tall portrait phone screens so obstacles in
    // the side lanes stay on-screen as they approach.
    this.camera.fov = this.camera.aspect < 0.6 ? 70 : 60;
    this.camera.updateProjectionMatrix();
  }

  // Garage turntable: spin the car, framed in the upper part of the screen so
  // the (bottom-anchored) Garage panel doesn't cover it.
  setShowcase(on) {
    this.showcase = on;
    if (!on && this.camera) {
      this.camera.clearViewOffset();
      if (this.car) { this.car.rotation.set(0, 0, 0); this.car.position.set(0, 0, 0); }
    }
  }
  _renderShowcase(dt) {
    this._spin = (this._spin || 0) + dt * 0.7;
    this.car.position.set(0, 0, 0);
    this.car.rotation.set(0, this._spin, 0);
    if (this.wheels) for (const w of this.wheels) w.rotation.x -= dt * 0.4;
    // Nice 3/4 framing, then shift the rendered image UP so the car sits in the
    // open strip above the (bottom-anchored) Garage panel.
    const sz = this.r.getSize(new THREE.Vector2());
    this.camera.setViewOffset(sz.x, sz.y, 0, Math.round(sz.y * 0.30), sz.x, sz.y);
    this.camera.position.set(4.4, 2.5, 5.8);
    this.camLook.set(0, 0.7, 0);
    this.camera.lookAt(this.camLook);
    this._poolResetAll(); this._poolHideUnused();   // hide any gameplay objects
    if (this.composer) this.composer.render(dt); else this.r.render(this.scene, this.camera);
  }

  // ---- Frame --------------------------------------------------------------
  render(engine, dt) {
    if (this._contextLost) return;          // GPU dropped the context; wait for restore
    this.t += dt;
    const c = this.cfg;

    if (this.showcase) { this._renderShowcase(dt); return; }

    // Scroll the road & grass textures with travelled distance.
    // Keep offsets wrapped to [0,1) so they never drift into float-precision jitter.
    const dScroll = engine.state === "playing" ? engine.speed * dt
      : (engine.state === "ready" ? c.START_SPEED * 0.5 * dt : engine.speed * dt);
    const uPerUnit = this.roadRepeat / this.roadLen;
    this.roadTex.offset.y = (this.roadTex.offset.y - dScroll * this.DEPTH * uPerUnit) % 1;
    this.grassTex.offset.y = (this.grassTex.offset.y - dScroll * this.DEPTH * (200 / 800)) % 1;

    // Player car follows the lane; lean + bob for life.
    const speed01 = Math.max(0, Math.min(1, (engine.speed - c.START_SPEED) / (c.MAX_SPEED - c.START_SPEED)));
    const targetFrac = c.LANES[engine.player.lane];
    const lean = Math.max(-1, Math.min(1, (targetFrac - engine.player.laneFrac) * 4));
    this.car.position.x = this._wx(engine.player.laneFrac);
    this.car.position.z = 0;
    this.car.rotation.z = -lean * 0.16;
    this.car.rotation.y = -lean * 0.12;
    const bob = engine.state === "playing" ? Math.sin(this.t * (24 + speed01 * 18)) * 0.02 * (0.4 + speed01) : 0;
    this.car.position.y = bob;

    // Camera: trail the car a touch and add speed shake.
    const camX = this.car.position.x * 0.45;
    const shake = engine.state === "playing" ? Math.sin(this.t * 30) * 0.015 * speed01 : 0;
    this.camera.position.x += (camX - this.camera.position.x) * Math.min(1, dt * 4);
    this.camera.position.y = 3.05 + shake;
    this.camLook.set(this.car.position.x * 0.5, 0.9, -24);
    this.camera.lookAt(this.camLook);

    // --- Sync dynamic objects from engine via pools ---
    this._poolResetAll();

    for (const o of engine.obstacles) {
      const wz = this._wz(o.z);
      if (wz < -160 || wz > 16) continue;
      let m;
      if (o.type === "cone") m = this._poolGet("cone", () => this._makeCone());
      else if (o.type === "barrier") m = this._poolGet("barrier", () => this._makeBarrier());
      else if (o.type === "pothole") m = this._poolGet("pothole", () => this._makePothole());
      else m = this._poolGet("car", () => this._makeIssueCar());
      m.position.set(this._wx(c.LANES[o.lane]), 0, wz);
    }

    for (const k of engine.coins) {
      const wz = this._wz(k.z);
      if (wz < -160 || wz > 16) continue;
      const m = this._poolGet("coin", () => this._makeCoin());
      m.position.set(this._wx(k.frac), 0.75 + Math.sin(this.t * 4 + k.z) * 0.08, wz);
      m.rotation.y = this.t * 5 + k.z;
    }

    for (const k of (engine.powerups || [])) {
      const wz = this._wz(k.z);
      if (wz < -160 || wz > 16) continue;
      const m = this._poolGet("power", () => this._makePower());
      m.position.set(this._wx(k.frac), 0.95 + Math.sin(this.t * 4 + k.z) * 0.12, wz);
      m.rotation.z = this.t * 2.4 + k.z;
      const s = 1 + Math.sin(this.t * 6 + k.z) * 0.1;
      m.scale.set(s, s, s);
    }

    // Scenery: deterministic slots scrolling toward the camera.
    const gap = 14;
    const base = Math.floor(engine.scroll / gap);
    for (let i = 0; i < (c.FAR_Z / gap) + 2; i++) {
      const idx = base + i;
      const z = (idx + 1) * gap - engine.scroll;
      const wz = this._wz(z);
      if (wz < -170 || wz > 14) continue;
      const side = (idx % 2 === 0) ? -1 : 1;
      const x = side * (this.ROAD_HALF + 2.2 + (idx % 3) * 0.8);
      if ((idx * 7) % 5 === 0) {
        const m = this._poolGet("lamp", () => this._makeLamp());
        m.position.set(x, 0, wz); m.rotation.y = side < 0 ? 0 : Math.PI;
      } else {
        const m = this._poolGet("tree", () => this._makeTree());
        const s = 0.8 + (idx % 4) * 0.18;
        m.position.set(x, 0, wz); m.scale.set(s, s, s);
        m.rotation.y = idx * 1.3;
      }
    }

    this._poolHideUnused();
    this._updateParticles(dt);

    // Spin the player's wheels with travelled distance.
    if (this.wheels) {
      const spin = dScroll * this.DEPTH * 0.7;
      for (const w of this.wheels) w.rotation.x -= spin;
    }

    // Render. If the bloom composer ever errors on a device, drop it and fall
    // back to direct rendering so the game keeps running instead of crashing.
    try {
      if (this.composer) this.composer.render(dt);
      else this.r.render(this.scene, this.camera);
    } catch (e) {
      this.composer = null;
      try { this.r.render(this.scene, this.camera); } catch (e2) { /* context likely lost */ }
    }
  }
}

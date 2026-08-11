// The run: simulation, collision, camera and scoring.

import * as THREE from '../vendor/three.module.js';
import {
  SHIP_R, GRAZE_R, SPEED_BASE, SPEED_MAX, SPEED_RAMP,
  OVERDRIVE_SPEED, OVERDRIVE_TIME, OVERDRIVE_SCORE,
  CAM_BACK, CAM_UP, CAM_LOOK, CAM_LAG, CAM_OFFSET_FOLLOW,
  FOG_NEAR, FOG_FAR, SHIELD_INVULN, SCORE_PER_METRE, SCORE_CELL, SCORE_GRAZE,
  MULT_MAX, HEAT_DRAIN, GRAZE_TICK, CHARGE_PER_CELL, CHARGE_PER_GRAZE,
  CELL_MAGNET, REBASE_AT,
} from './config.js';
import { World } from './world.js';
import { Ship } from './ship.js';
import { FX } from './fx.js';
import { Spawner } from './spawner.js';
import { Pickups, CELL, SHIELD } from './pickups.js';
import { makeHazardMaterials, tintHazardMaterials, warmGeometry, KINDS } from './hazards.js';
import { frameAt, setCurveScale, setRollEnabled, tubeToWorld } from './path.js';
import { zoneAt, tierSpeed, zoneLabel } from './zones.js';
import { clamp, damp, lerp } from './util.js';

const STATE = { MENU: 'menu', PLAY: 'play', PAUSE: 'pause', DEAD: 'dead' };

/** Cruise speed at a given distance, with no overdrive and no ship state.
 *  The spawner uses it to predict when the player will reach a hazard. */
export function cruiseAt(dist) {
  const info = zoneAt(dist);
  const base = SPEED_BASE + (SPEED_MAX - SPEED_BASE) * (1 - Math.exp(-dist / SPEED_RAMP));
  return base * info.zone.speedMul * tierSpeed(info.tier);
}

const _v = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = { x: 0, y: 0, z: 0 }, _rt = { x: 0, y: 0, z: 0 }, _tg = { x: 0, y: 0, z: 0 };

export class Game {
  constructor({ canvas, audio, save, hud, input }) {
    this.audio = audio;
    this.save = save;
    this.hud = hud;
    this.input = input;
    this.state = STATE.MENU;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false,
      powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setClearColor(0x050b1a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.35, 1200);
    this.scene.add(this.camera);

    warmGeometry();
    this.hazMat = makeHazardMaterials();
    this.world = new World(this.scene, this.renderer);
    this.pickups = new Pickups(this.scene);
    this.spawner = new Spawner(this.scene, this.hazMat, this.pickups);
    this.spawner.speedAt = cruiseAt;
    this.ship = new Ship(this.scene);
    this.fx = new FX(this.scene);

    this.originZ = 0;
    this.time = 0;
    this.dpr = 1;
    this.quality = 1;
    this._frameAcc = 0;
    this._frameN = 0;
    this._qLocked = false;
    this.reduceMotion = false;

    this.run = this._blankRun();
    this.camOX = 0; this.camOY = 0;
    this.fov = 72;
    this.hitFlash = 0;
    this.damage = 0;
    this.zoneRaw = -1;
    this.burstCol = new THREE.Color();

    this.onResize();
  }

  _blankRun() {
    return {
      dist: 0, score: 0, cells: 0, grazes: 0, overdrives: 0,
      mult: 1, heat: 0, bestMult: 1, charge: 0,
      shields: 3, maxShields: 3, sector: 1, cleanDist: 0, lastHitDist: 0,
      overdrive: 0, grazeAcc: 0, alive: true, ship: 'scout',
    };
  }

  /* ------------------------------------------------------------------ */

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const maxDpr = this.quality >= 1 ? 2 : this.quality >= 0.7 ? 1.5 : 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.portrait = h > w;
    this.baseFov = this.portrait ? 78 : 66;
    this.camera.updateProjectionMatrix();
  }

  setQuality(q) {
    this.quality = q;
    this.fx.setQuality(q);
    this.world.setFogRange(FOG_NEAR, lerp(FOG_FAR * 0.72, FOG_FAR, q));
    this.onResize();
  }

  applySettings() {
    const s = this.save.settings;
    setRollEnabled(s.roll);
    this.input.sens = s.sens;
    this.input.mode = s.mode;
    this.audio.setMusic(s.music);
    this.audio.setSfx(s.sfx);
    if (s.quality === 'low') { this._qLocked = true; this.setQuality(0.5); }
    else if (s.quality === 'high') { this._qLocked = true; this.setQuality(1); }
    else { this._qLocked = false; }
  }

  /* ------------------------------------------------------------------ */

  enterMenu(shipDef) {
    this.state = STATE.MENU;
    this.autopilot = true;
    this._begin(shipDef, 0x9e1f5c);
    this.audio.stop();
  }

  startRun(shipDef) {
    this.autopilot = false;
    this._begin(shipDef, (Math.random() * 0xffffffff) >>> 0);
    this.state = STATE.PLAY;
    this.input.enabled = true;
    this.input.reset(0, 0);
    this.hud.reset();
    this.hud.setShieldMax(this.run.maxShields, this.run.shields);
    this.hud.setSector(zoneLabel(zoneAt(0)));
    this.audio.setZone(zoneAt(0).zone);
    this.audio.start();
  }

  _begin(shipDef, seed) {
    this.shipDef = shipDef;
    this.ship.build(shipDef);
    this.ship.reset();
    this.ship.inner.visible = true;
    this.originZ = 0;
    this.time = 0;
    this.hitFlash = 0;
    this.damage = 0;
    this.zoneRaw = -1;
    this.camOX = 0; this.camOY = 0;

    this.run = this._blankRun();
    this.run.ship = shipDef.id;
    this.run.maxShields = shipDef.stats.shields;
    this.run.shields = shipDef.stats.shields;

    setCurveScale(1);
    this.pickups.clear();
    this.spawner.reset(seed);
    this.world.reset(this.ship.z);
    this.fx.clear();
    this._syncZone(0, true);
    this.spawner.generate(this.ship.z, this.originZ, 0, SPEED_BASE, this.time, zoneAt(0));
    this.ship.place();
    this._camera(0.016, true);
  }

  pause() {
    if (this.state !== STATE.PLAY) return;
    this.state = STATE.PAUSE;
    this.input.enabled = false;
    this.audio.stop();
  }

  resume() {
    if (this.state !== STATE.PAUSE) return;
    this.state = STATE.PLAY;
    this.input.enabled = true;
    this.input.reset(this.ship.ox, this.ship.oy);
    this.audio.start();
  }

  /** Cruise speed, ignoring overdrive. Timed hazards are phased against this
   *  so a burst does not desynchronise everything spawned during it. */
  get baseSpeed() { return cruiseAt(this.run.dist); }

  get speed() {
    return this.baseSpeed * (this.run.overdrive > 0 ? OVERDRIVE_SPEED : 1);
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const r = this.run;
    const playing = this.state === STATE.PLAY;
    const menu = this.state === STATE.MENU;
    if (this.state === STATE.PAUSE) { this._camera(dt, false); return; }

    const info = zoneAt(r.dist);
    const speed = this.speed;
    const speed01 = clamp((speed - SPEED_BASE) / (SPEED_MAX * 1.5 - SPEED_BASE), 0, 1);

    // --- steering -------------------------------------------------
    if (menu || !r.alive) {
      this._autopilot(dt);
    } else {
      this.input.tick(dt);
      this.ship.tx = this.input.tx;
      this.ship.ty = this.input.ty;
      if (this.input.consumeBoost()) this._tryOverdrive();
    }

    // --- forward integration, substepped so nothing tunnels ---------
    const dz = speed * dt;
    const steps = clamp(Math.ceil(dz / 2.2), 1, 6);
    const sdt = dt / steps;

    for (let s = 0; s < steps; s++) {
      this.ship.fly(sdt, r.overdrive > 0);
      this.ship.z += speed * sdt;
      this.ship.absZ = this.ship.z + this.originZ;
      if (playing || menu) this._collide(sdt, playing && r.alive);
    }

    if (this.ship.invuln > 0) this.ship.invuln = Math.max(0, this.ship.invuln - dt);
    r.dist = this.ship.z + this.originZ;
    setCurveScale(1 + 0.32 * (1 - Math.exp(-r.dist / 9000)));

    // --- overdrive --------------------------------------------------
    if (r.overdrive > 0) {
      r.overdrive = Math.max(0, r.overdrive - dt);
      r.charge = r.overdrive / OVERDRIVE_TIME;
      this.spawner.shatter(this.ship.z, 26, (h) => this._shatter(h));
      if (r.overdrive === 0) {
        // Coming out of a burst we are ahead of where the generator predicted,
        // so re-aim everything still in front of us.
        this.spawner.rephase(this.ship.z, this.time, r.dist);
        this.hud.toast('OVERDRIVE OFF');
      }
    }

    // --- scoring ----------------------------------------------------
    if (playing && r.alive) {
      const mulScore = r.mult * (r.overdrive > 0 ? OVERDRIVE_SCORE : 1) * this.shipDef.stats.score;
      r.score += SCORE_PER_METRE * dz * mulScore;
      if (r.dist - r.lastHitDist > r.cleanDist) r.cleanDist = r.dist - r.lastHitDist;

      r.heat -= HEAT_DRAIN * dt;
      if (r.heat <= 0) {
        if (r.mult > 1) { r.mult--; r.heat = 0.55; }
        else r.heat = 0;
      }
    }

    // --- pickups ----------------------------------------------------
    const magnet = CELL_MAGNET * this.shipDef.stats.magnet * (r.overdrive > 0 ? 1.9 : 1);
    const got = this.pickups.update(dt, this.time, this.ship, magnet, this.ship.z - 24);
    if (playing && r.alive) this._collect(got, info);

    // --- world ------------------------------------------------------
    this.spawner.update(this.time, dt, this.ship.z);
    this.spawner.generate(this.ship.z, this.originZ, r.dist, this.baseSpeed, this.time, info);
    this.world.update(this.ship.z, this.camera);
    this.fx.update(dt);

    if (this.ship.z > REBASE_AT) this._rebase(REBASE_AT);

    // --- presentation ----------------------------------------------
    this._syncZone(r.dist, false);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.4);
    this.damage = damp(this.damage, r.alive ? clamp(1 - r.shields / r.maxShields, 0, 1) * 0.55 + (this.hitFlash > 0 ? 0.5 : 0) : 0.8, 6, dt);

    this.ship.place();
    this.ship.updateVisual(dt, speed01, r.overdrive > 0, this.hitFlash);
    this._camera(dt, false);

    this.audio.setEngine(speed01, r.overdrive > 0);
    this.audio.setIntensity(clamp((r.mult - 1) / 5 + (r.overdrive > 0 ? 0.5 : 0) + speed01 * 0.35, 0, 1));

    if (playing) {
      r.bestMult = Math.max(r.bestMult, r.mult);
      r.sector = info.raw + 1;
      this.hud.update({
        dist: r.dist, score: r.score, cells: r.cells, mult: r.mult, heat: r.heat,
        charge: r.charge, overdrive: r.overdrive > 0, damage: this.damage,
        sectorProgress: info.progress,
      });
    }
  }

  /* ------------------------------------------------------------------ */

  _autopilot(dt) {
    const list = this.spawner.hazards;
    let tx = 0, ty = 0, found = false;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (h.z > this.ship.z + 14) { tx = h.flowX; ty = h.flowY; found = true; break; }
    }
    if (!found) { tx = 0; ty = 0; }
    this.ship.tx = damp(this.ship.tx, tx, 5.5, dt);
    this.ship.ty = damp(this.ship.ty, ty, 5.5, dt);
  }

  requestOverdrive() { this._tryOverdrive(); }

  _tryOverdrive() {
    const r = this.run;
    if (r.overdrive > 0 || r.charge < 1 || !r.alive) return;
    r.overdrive = OVERDRIVE_TIME;
    r.overdrives++;
    this.spawner.rephase(this.ship.z, this.time, r.dist);
    this.ship.invuln = Math.max(this.ship.invuln, OVERDRIVE_TIME);
    this.fx.addShake(0.5);
    this.audio.overdrive();
    this.hud.showBanner('OVERDRIVE', 'RAM EVERYTHING', 1400);
    this.hud.toast('OVERDRIVE', 'good');
    this._haptic(30);
    this.fx.ring(this.ship.root.position, this.ship.root.quaternion, this.world.palette.accent, 1, 26, 0.7);
  }

  _shatter(h) {
    tubeToWorld(h.absZ, h.z, 0, 0, _v);
    this.burstCol.copy(this.world.palette.hazEdge);
    this.fx.burst(_v, 26, this.burstCol, 16, 1.5, 0.7, 6);
    this.fx.ring(_v, this.ship.root.quaternion, this.world.palette.hazard, 1, 14, 0.4);
    this.audio.shatter();
    this.run.score += 120 * this.run.mult;
    this.fx.addShake(0.10);
  }

  /**
   * Collision + near-miss.
   *
   * Grazing is scored per hazard, not per frame: we track the closest the ship
   * ever came to each hazard and cash it in the moment we pass it. An
   * accumulator would never fire, because at 100 units a second you are only
   * beside a hazard for about 70 milliseconds.
   */
  _collide(sdt, live) {
    const list = this.spawner.hazards;
    const r = this.run;
    const ship = this.ship;
    const grazeR = SHIP_R + GRAZE_R * this.shipDef.stats.graze;

    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      const dz = h.z - ship.z;
      const half = h.depth * 0.5;
      if (dz > half + 5.0) continue;

      if (dz < -half - 0.8) {
        if (!h.scored) { h.scored = true; if (live) this._scorePass(h, grazeR); }
        continue;
      }

      const sd = KINDS[h.kind].sdf(h, ship.ox, ship.oy);
      if (sd < h.minSd) h.minSd = sd;

      if (Math.abs(dz) < half + SHIP_R * 0.6 && sd < SHIP_R) {
        if (live && ship.invuln <= 0) { this._hit(h); return; }
        if (r.overdrive > 0) { this._shatter(h); this.spawner.pool.release(h); list.splice(i, 1); }
        continue;
      }

      // Sparks while we are inside the graze skin - pure feedback, no scoring.
      if (live && sd < grazeR && r.overdrive <= 0) {
        r.grazeAcc += sdt;
        if (r.grazeAcc >= GRAZE_TICK) {
          r.grazeAcc = 0;
          this.burstCol.copy(this.world.palette.hazEdge);
          this.fx.spark(this.ship.root.position, this.burstCol, 5);
        }
      }
    }
  }

  /** Cash in how close we came to a hazard we have now flown past. */
  _scorePass(h, grazeR) {
    const r = this.run;
    if (r.overdrive > 0 || h.minSd >= grazeR || h.minSd < SHIP_R * 0.5) return;
    const perfect = h.minSd < SHIP_R + 0.55;
    r.grazes++;
    r.score += SCORE_GRAZE * r.mult * (perfect ? 2 : 1);
    r.heat += perfect ? 0.46 : 0.27;
    r.charge = Math.min(1, r.charge + CHARGE_PER_GRAZE * (perfect ? 1.6 : 1) * this.shipDef.stats.charge);
    this.audio.graze(r.grazes);
    if (perfect) {
      this.burstCol.copy(this.world.palette.hazEdge);
      this.fx.spark(this.ship.root.position, this.burstCol, 9);
      if (r.grazes % 5 === 0) this.hud.toast('PERFECT', 'good');
    }
    this._checkHeat();
  }

  _checkHeat() {
    const r = this.run;
    if (r.heat >= 1) {
      if (r.mult < MULT_MAX) {
        r.mult++;
        r.heat = 0.25;
        this.audio.multUp(r.mult);
        this.hud.toast('x' + r.mult, 'good');
      } else r.heat = 1;
    }
  }

  _collect(got, info) {
    const r = this.run;
    if (!got.events.length) return;
    for (const it of got.events) {
      tubeToWorld(it.absZ, it.z, it.ox, it.oy, _v);
      if (it.type === CELL) {
        r.cells++;
        r.score += SCORE_CELL * r.mult;
        r.heat += 0.045;
        r.charge = Math.min(1, r.charge + CHARGE_PER_CELL * this.shipDef.stats.charge);
        this.burstCol.copy(this.world.palette.accent);
        this.fx.burst(_v, 6, this.burstCol, 5, 0.8, 0.35);
        this.audio.cell(r.cells);
        this._checkHeat();
      } else if (it.type === SHIELD) {
        if (r.shields < r.maxShields) { r.shields++; this.hud.setShields(r.shields); this.hud.toast('SHIELD +1', 'good'); }
        else { r.score += 400 * r.mult; this.hud.toast('BONUS', 'good'); }
        this.burstCol.setHex(0x4de1ff);
        this.fx.burst(_v, 18, this.burstCol, 9, 1.2, 0.6);
        this.audio.shield();
      } else {
        r.charge = Math.min(1, r.charge + 0.34 * this.shipDef.stats.charge);
        this.burstCol.setHex(0xff4ddb);
        this.fx.burst(_v, 18, this.burstCol, 9, 1.2, 0.6);
        this.audio.shield();
        this.hud.toast('CHARGE +', 'good');
      }
    }
    void info;
  }

  _hit(h) {
    const r = this.run;
    if (!r.alive) return;
    r.shields--;
    r.mult = 1;
    r.heat = 0;
    r.grazeAcc = 0;
    r.lastHitDist = r.dist;
    this.ship.invuln = SHIELD_INVULN;
    this.hitFlash = 1;
    this.fx.addShake(0.95);
    this.audio.hit();
    this._haptic(60);

    tubeToWorld(h.absZ, h.z, this.ship.ox, this.ship.oy, _v);
    this.burstCol.copy(this.world.palette.hazEdge);
    this.fx.burst(_v, 34, this.burstCol, 18, 1.6, 0.8);
    this.fx.ring(_v, this.ship.root.quaternion, this.burstCol, 1, 16, 0.5);

    // Remove the thing we hit so we never end up stuck inside it.
    const list = this.spawner.hazards;
    const idx = list.indexOf(h);
    if (idx >= 0) { this.spawner.pool.release(h); list.splice(idx, 1); }

    this.hud.setShields(r.shields);
    if (r.shields <= 0) this._die();
    else this.hud.toast('HULL BREACH', 'bad');
  }

  _die() {
    const r = this.run;
    r.alive = false;
    this.state = STATE.DEAD;
    this.input.enabled = false;
    this.fx.addShake(1.4);
    this.audio.gameOver();
    this.audio.stop();
    this._haptic([40, 60, 120]);
    this.burstCol.copy(this.world.palette.hazEdge);
    this.fx.burst(this.ship.root.position, 90, this.burstCol, 26, 2.2, 1.4);
    this.fx.ring(this.ship.root.position, this.ship.root.quaternion, this.burstCol, 1, 34, 0.9);
    this.ship.inner.visible = false;
    if (this.onDeath) this.onDeath({ ...r });
  }

  _haptic(p) {
    if (!this.save.settings.haptics) return;
    try { navigator.vibrate?.(p); } catch { /* unsupported */ }
  }

  _rebase(delta) {
    this.originZ += delta;
    this.ship.z -= delta;
    this.ship.absZ = this.ship.z + this.originZ;
    this.world.rebase(delta);
    this.spawner.rebase(delta);
    this.pickups.rebase(delta);
    for (let i = 0; i < this.fx.pos.length; i += 3) this.fx.pos[i + 2] -= delta;
    this.fx.geo.attributes.position.needsUpdate = true;
    for (const rr of this.fx.rings) rr.m.position.z -= delta;
    this.camera.position.z -= delta;
  }

  _syncZone(dist, force) {
    const info = zoneAt(dist);
    this.world.applyPalette(info, this.hitFlash * 0.5);
    tintHazardMaterials(this.hazMat, this.world.palette.hazard, this.world.palette.hazEdge, this.world.palette.hazEdge);
    this.pickups.tint(this.world.palette.accent, this.world.palette.accent);
    if (this.onPalette && (force || this.time - (this._palT || -1) > 0.25)) {
      this._palT = this.time;
      this.onPalette(this.world.palette);
    }
    if (info.raw !== this.zoneRaw) {
      const first = this.zoneRaw < 0;
      this.zoneRaw = info.raw;
      this.audio.setZone(info.zone);
      if (!first && this.state === STATE.PLAY) {
        this.hud.showBanner(info.zone.name, info.zone.tag);
        this.hud.setSector(zoneLabel(info));
        this.audio.zone();
        this.fx.addShake(0.22);
        this.run.score += 500 * this.run.mult;
      } else if (force || first) {
        this.hud.setSector(zoneLabel(info));
      }
    }
  }

  _camera(dt, snap) {
    const ship = this.ship;
    const lam = snap ? 1e6 : CAM_LAG;
    // Portrait has a narrow horizontal field, so the camera has to hug the
    // ship's x more tightly or the ship swings off the side of the screen.
    const followX = this.portrait ? 0.88 : CAM_OFFSET_FOLLOW;
    const followY = CAM_OFFSET_FOLLOW;
    this.camOX = damp(this.camOX, ship.ox * followX, lam, dt);
    this.camOY = damp(this.camOY, ship.oy * followY, lam, dt);

    // Hard guarantee: the ship stays inside the middle of the frame.
    const hy = Math.tan((this.fov * Math.PI) / 360) * CAM_BACK;
    const hx = hy * this.camera.aspect;
    this.camOX = clamp(this.camOX, ship.ox - hx * 0.42, ship.ox + hx * 0.42);
    this.camOY = clamp(this.camOY, ship.oy - hy * 0.34, ship.oy + hy * 0.34);

    const camZ = ship.z - CAM_BACK;
    const camAbs = camZ + this.originZ;
    tubeToWorld(camAbs, camZ, this.camOX, this.camOY + CAM_UP, _v);

    // Look almost straight down the corridor from wherever the camera sits,
    // leading only slightly toward the ship. Aiming at the ship's offset
    // instead would yaw the view and push the ship toward the screen edge.
    const lookZ = ship.z + CAM_LOOK;
    tubeToWorld(
      lookZ + this.originZ, lookZ,
      this.camOX + (ship.ox - this.camOX) * 0.35,
      this.camOY + (ship.oy - this.camOY) * 0.35,
      _look,
    );

    frameAt(camAbs, _rt, _up, _tg);
    this.camera.up.set(_up.x, _up.y, _up.z);
    this.camera.position.copy(_v);

    const sh = this.fx.shake;
    if (sh > 0.001) {
      const a = sh * 0.85;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a * 0.4;
    }
    this.camera.lookAt(_look);

    const r = this.run;
    const speed01 = clamp((this.speed - SPEED_BASE) / (SPEED_MAX * 1.5 - SPEED_BASE), 0, 1);
    const want = this.baseFov + speed01 * 7 + (r.overdrive > 0 ? 11 : 0);
    this.fov = snap ? want : damp(this.fov, want, 4.5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------ */

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  measure(dtMs) {
    if (this._qLocked) return;
    this._frameAcc += dtMs;
    this._frameN++;
    if (this._frameN < 90) return;
    const avg = this._frameAcc / this._frameN;
    this._frameAcc = 0; this._frameN = 0;
    if (avg > 22 && this.quality > 0.5) this.setQuality(this.quality === 1 ? 0.7 : 0.5);
    else if (avg < 12.5 && this.quality < 1) this.setQuality(this.quality === 0.5 ? 0.7 : 1);
  }
}

export { STATE };

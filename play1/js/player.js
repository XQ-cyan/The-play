/* ============================================================
 * player.js — 第一人称玩家：视角控制 + 物理 + 方块交互
 *
 * 功能：
 *  1. 视角：桌面端 PointerLock 鼠标控制；移动端右屏触摸拖动。
 *  2. 移动：桌面 WASD + 空格跳跃；移动端左屏虚拟摇杆 + 跳跃按钮。
 *  3. 物理：重力下落 + AABB 分轴碰撞检测（玩家盒 0.6×1.8×0.6）。
 *  4. 交互：相机中心射线 DDA 命中方块；左键/放置按钮 放置方块，
 *     右键/破坏按钮 破坏方块。
 * 依赖：Three.js、Blocks、World
 * ============================================================ */

(function (global) {
    "use strict";

    // 玩家物理尺寸
    const PLAYER_HALF = 0.3;   // 半宽（x/z）
    const PLAYER_HEIGHT = 1.8; // 总高
    const EYE_HEIGHT = 1.62;   // 眼睛距脚高度
    const GRAVITY = 26;        // 重力加速度
    const JUMP_SPEED = 8.2;    // 起跳速度
    const MOVE_SPEED = 4.6;    // 水平移动速度
    const MAX_PITCH = Math.PI / 2 - 0.02;

    class Player {
        constructor(camera, world, domElement) {
            this.camera = camera;
            this.world = world;
            this.dom = domElement;

            // 位置 = 脚部中心
            this.position = new THREE.Vector3(0.5, WorldConstants.SEA_LEVEL + 2, 0.5);
            this.velocity = new THREE.Vector3(0, 0, 0);
            this.onGround = false;

            // 视角欧拉角
            this.yaw = 0;    // 绕 Y（左右）
            this.pitch = 0;  // 绕 X（上下），玩家出生朝 -Z

            // 输入状态
            this.keys = {};         // 桌面键盘
            this.moveInput = { x: 0, y: 0 }; // 移动向量（-1~1），y=前后
            this.isTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;

            this.locked = false; // pointer lock 状态

            this._initInput();
            this._syncCamera();
        }

        /* ---------------- 输入初始化 ---------------- */
        _initInput() {
            // 键盘
            window.addEventListener("keydown", (e) => { this.keys[e.code] = true; });
            window.addEventListener("keyup", (e) => { this.keys[e.code] = false; });

            // 桌面：点击进入 pointer lock
            this.dom.addEventListener("click", () => {
                if (!this.isTouch && !this.locked) {
                    this.dom.requestPointerLock && this.dom.requestPointerLock();
                }
            });

            // pointer lock 状态变化
            document.addEventListener("pointerlockchange", () => {
                this.locked = (document.pointerLockElement === this.dom);
            });

            // 鼠标移动控制视角（仅锁定时）
            document.addEventListener("mousemove", (e) => {
                if (!this.locked) return;
                this.yaw -= e.movementX * 0.0025;
                this.pitch -= e.movementY * 0.0025;
                this._clampPitch();
            });

            // 鼠标按键：左键放置，右键破坏
            this.dom.addEventListener("mousedown", (e) => {
                if (!this.locked) return;
                if (e.button === 0) this.placeBlock();
                else if (e.button === 2) this.breakBlock();
            });
            this.dom.addEventListener("contextmenu", (e) => e.preventDefault());

            if (this.isTouch) {
                this._initTouch();
            }
        }

        /* ---------------- 移动端触摸控制 ---------------- */
        _initTouch() {
            const joystickZone = document.getElementById("joystick-zone");
            const base = document.getElementById("joystick-base");
            const knob = document.getElementById("joystick-knob");

            // 摇杆：在左下区域按下即激活
            let joyId = null, joyOrigin = { x: 0, y: 0 };
            const JOY_RADIUS = 50;

            joystickZone.addEventListener("touchstart", (e) => {
                if (joyId !== null) return;
                const t = e.changedTouches[0];
                joyId = t.identifier;
                joyOrigin.x = t.clientX;
                joyOrigin.y = t.clientY;
                base.style.left = (t.clientX - 60) + "px";
                base.style.bottom = "auto";
                base.style.top = (t.clientY - 60) + "px";
                base.style.display = "block";
                e.preventDefault();
            }, { passive: false });

            const joyMove = (e) => {
                for (const t of e.changedTouches) {
                    if (t.identifier !== joyId) continue;
                    let dx = t.clientX - joyOrigin.x;
                    let dy = t.clientY - joyOrigin.y;
                    const len = Math.hypot(dx, dy);
                    if (len > JOY_RADIUS) { dx = dx / len * JOY_RADIUS; dy = dy / len * JOY_RADIUS; }
                    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
                    this.moveInput.x = dx / JOY_RADIUS;
                    this.moveInput.y = -dy / JOY_RADIUS; // 上为前
                }
                e.preventDefault();
            };
            const joyEnd = (e) => {
                for (const t of e.changedTouches) {
                    if (t.identifier === joyId) {
                        joyId = null;
                        this.moveInput.x = 0;
                        this.moveInput.y = 0;
                        knob.style.transform = "translate(-50%, -50%)";
                        base.style.display = "none";
                    }
                }
            };
            joystickZone.addEventListener("touchmove", joyMove, { passive: false });
            joystickZone.addEventListener("touchend", joyEnd);
            joystickZone.addEventListener("touchcancel", joyEnd);

            // 右屏拖动视角：监听整个容器，排除摇杆区与按钮
            const lookIds = new Map(); // id -> {lastX, lastY}
            this.dom.addEventListener("touchstart", (e) => {
                for (const t of e.changedTouches) {
                    // 排除左下摇杆区（屏幕宽度 45%、高度 45%）
                    if (t.clientX < window.innerWidth * 0.45 && t.clientY > window.innerHeight * 0.55) continue;
                    // 排除按钮区
                    const target = document.elementFromPoint(t.clientX, t.clientY);
                    if (target && target.closest(".action-btn")) continue;
                    lookIds.set(t.identifier, { x: t.clientX, y: t.clientY });
                }
            }, { passive: false });
            this.dom.addEventListener("touchmove", (e) => {
                for (const t of e.changedTouches) {
                    if (!lookIds.has(t.identifier)) continue;
                    const last = lookIds.get(t.identifier);
                    this.yaw -= (t.clientX - last.x) * 0.005;
                    this.pitch -= (t.clientY - last.y) * 0.005;
                    this._clampPitch();
                    last.x = t.clientX;
                    last.y = t.clientY;
                }
                e.preventDefault();
            }, { passive: false });
            const lookEnd = (e) => {
                for (const t of e.changedTouches) lookIds.delete(t.identifier);
            };
            this.dom.addEventListener("touchend", lookEnd);
            this.dom.addEventListener("touchcancel", lookEnd);

            // 按钮绑定
            const bind = (id, fn) => {
                const el = document.getElementById(id);
                if (el) el.addEventListener("touchstart", (e) => { fn(); e.preventDefault(); }, { passive: false });
            };
            bind("btn-jump", () => this._tryJump());
            bind("btn-break", () => this.breakBlock());
            bind("btn-place", () => this.placeBlock());
        }

        _clampPitch() {
            if (this.pitch > MAX_PITCH) this.pitch = MAX_PITCH;
            if (this.pitch < -MAX_PITCH) this.pitch = -MAX_PITCH;
        }

        _tryJump() {
            if (this.onGround) {
                this.velocity.y = JUMP_SPEED;
                this.onGround = false;
            }
        }

        /* ---------------- 主更新 ---------------- */
        update(dt) {
            // 1. 读取水平移动输入
            let ix = 0, iz = 0;
            if (this.isTouch) {
                ix = this.moveInput.x;
                iz = this.moveInput.y;
            } else {
                if (this.keys["KeyW"]) iz += 1;
                if (this.keys["KeyS"]) iz -= 1;
                if (this.keys["KeyA"]) ix -= 1;
                if (this.keys["KeyD"]) ix += 1;
                if (this.keys["Space"]) this._tryJump();
            }
            // 归一化对角线
            const inLen = Math.hypot(ix, iz);
            if (inLen > 1) { ix /= inLen; iz /= inLen; }

            // 基于 yaw 计算世界空间水平方向（前方向量为 -Z 旋转 yaw）
            const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
            // 前进方向（水平）：(-sin, 0, -cos) 对应 yaw=0 朝 -Z
            const forwardX = -sin, forwardZ = -cos;
            // 右方向：(cos, 0, -sin)
            const rightX = cos, rightZ = -sin;
            const wishX = (forwardX * iz + rightX * ix) * MOVE_SPEED;
            const wishZ = (forwardZ * iz + rightZ * ix) * MOVE_SPEED;

            this.velocity.x = wishX;
            this.velocity.z = wishZ;

            // 2. 重力
            this.velocity.y -= GRAVITY * dt;

            // 3. 分轴碰撞移动
            this.onGround = false;
            this._moveAxis("x", this.velocity.x * dt);
            this._moveAxis("z", this.velocity.z * dt);
            this._moveAxis("y", this.velocity.y * dt);

            // 4. 防止掉出世界
            if (this.position.y < -10) {
                this.position.set(0.5, WorldConstants.SEA_LEVEL + 2, 0.5);
                this.velocity.set(0, 0, 0);
            }

            // 5. 同步相机
            this._syncCamera();
        }

        /**
         * 沿单轴移动并做 AABB 碰撞检测
         * @param {"x"|"y"|"z"} axis
         * @param {number} d 位移
         */
        _moveAxis(axis, d) {
            this.position[axis] += d;
            // 玩家 AABB
            const minX = this.position.x - PLAYER_HALF;
            const maxX = this.position.x + PLAYER_HALF;
            const minY = this.position.y;
            const maxY = this.position.y + PLAYER_HEIGHT;
            const minZ = this.position.z - PLAYER_HALF;
            const maxZ = this.position.z + PLAYER_HALF;

            const bMinX = Math.floor(minX), bMaxX = Math.floor(maxX);
            const bMinY = Math.floor(minY), bMaxY = Math.floor(maxY);
            const bMinZ = Math.floor(minZ), bMaxZ = Math.floor(maxZ);

            let collided = false;
            let resolveTo = null;
            for (let bx = bMinX; bx <= bMaxX; bx++) {
                for (let by = bMinY; by <= bMaxY; by++) {
                    for (let bz = bMinZ; bz <= bMaxZ; bz++) {
                        if (!Blocks.isSolid(this.world.getBlock(bx, by, bz))) continue;
                        collided = true;
                        // 计算该轴的回退位置
                        if (axis === "x") {
                            resolveTo = d > 0 ? (bx - PLAYER_HALF - 1e-4) : (bx + 1 + PLAYER_HALF + 1e-4);
                        } else if (axis === "z") {
                            resolveTo = d > 0 ? (bz - PLAYER_HALF - 1e-4) : (bz + 1 + PLAYER_HALF + 1e-4);
                        } else { // y
                            if (d > 0) { // 头顶撞顶
                                resolveTo = by - PLAYER_HEIGHT - 1e-4;
                            } else { // 脚落地
                                resolveTo = by + 1 + 1e-4;
                                this.onGround = true;
                            }
                        }
                    }
                }
            }
            if (collided) {
                this.position[axis] = resolveTo;
                this.velocity[axis] = 0;
            }
        }

        /** 同步相机位置与朝向 */
        _syncCamera() {
            this.camera.position.set(
                this.position.x,
                this.position.y + EYE_HEIGHT,
                this.position.z
            );
            // 用欧拉角构造旋转：先 yaw(Y) 再 pitch(X)
            this.camera.rotation.set(0, 0, 0);
            this.camera.rotation.order = "YXZ";
            this.camera.rotation.y = this.yaw;
            this.camera.rotation.x = this.pitch;
        }

        /* ---------------- 方块交互（射线 DDA） ---------------- */
        /**
         * 从相机沿视线方向做体素 DDA，返回命中的方块坐标与法线
         * @returns {{block:[x,y,z], normal:[x,y,z]} | null}
         */
        raycast(maxDist = 6) {
            const origin = this.camera.position;
            const dir = new THREE.Vector3();
            this.camera.getWorldDirection(dir);

            let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
            const stepX = Math.sign(dir.x), stepY = Math.sign(dir.y), stepZ = Math.sign(dir.z);
            const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
            const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
            const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
            // 到下一个边界的距离
            let tMaxX = dir.x !== 0 ? ((stepX > 0 ? (x + 1 - origin.x) : (origin.x - x)) * tDeltaX) : Infinity;
            let tMaxY = dir.y !== 0 ? ((stepY > 0 ? (y + 1 - origin.y) : (origin.y - y)) * tDeltaY) : Infinity;
            let tMaxZ = dir.z !== 0 ? ((stepZ > 0 ? (z + 1 - origin.z) : (origin.z - z)) * tDeltaZ) : Infinity;

            let normal = [0, 0, 0];
            let t = 0;
            while (t <= maxDist) {
                if (Blocks.isSolid(this.world.getBlock(x, y, z))) {
                    return { block: [x, y, z], normal: normal };
                }
                if (tMaxX < tMaxY && tMaxX < tMaxZ) {
                    x += stepX; t = tMaxX; tMaxX += tDeltaX; normal = [-stepX, 0, 0];
                } else if (tMaxY < tMaxZ) {
                    y += stepY; t = tMaxY; tMaxY += tDeltaY; normal = [0, -stepY, 0];
                } else {
                    z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; normal = [0, 0, -stepZ];
                }
            }
            return null;
        }

        /** 破坏射线命中的方块 */
        breakBlock() {
            const hit = this.raycast();
            if (!hit) return;
            const [x, y, z] = hit.block;
            this.world.setBlock(x, y, z, Blocks.BlockType.AIR);
            this.world.rebuildAround(x, z);
        }

        /**
         * 在命中方块的法线侧放置当前选中方块
         * @param {number} type 方块类型
         */
        placeBlock(type) {
            const hit = this.raycast();
            if (!hit) return;
            const [bx, by, bz] = hit.block;
            const [nx, ny, nz] = hit.normal;
            const px = bx + nx, py = by + ny, pz = bz + nz;
            // 不能放在玩家自身所在格子
            if (this._intersectsPlayer(px, py, pz)) return;
            this.world.setBlock(px, py, pz, type);
            this.world.rebuildAround(px, pz);
        }

        /** 检查方块 [px,px+1]×... 是否与玩家 AABB 相交 */
        _intersectsPlayer(px, py, pz) {
            const minX = this.position.x - PLAYER_HALF, maxX = this.position.x + PLAYER_HALF;
            const minY = this.position.y, maxY = this.position.y + PLAYER_HEIGHT;
            const minZ = this.position.z - PLAYER_HALF, maxZ = this.position.z + PLAYER_HALF;
            return (
                px < maxX && px + 1 > minX &&
                py < maxY && py + 1 > minY &&
                pz < maxZ && pz + 1 > minZ
            );
        }
    }

    global.Player = Player;
})(window);

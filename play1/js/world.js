/* ============================================================
 * world.js — 体素世界：地形生成 + 区块管理 + 渲染距离
 *
 * 设计要点：
 *  1. 方块数据按 chunk 存储（Uint8Array），chunk 大小 CHUNK_SIZE ×
 *     CHUNK_SIZE × WORLD_HEIGHT，世界在 y 方向固定高度。
 *  2. 地形用值噪声（多频率叠加）生成高度，表层草/沙，下层泥土、石头。
 *  3. 出生点附近半径内强制为沙质平地，作为"世界中心沙质平地"。
 *  4. 渲染采用"每 chunk 每方块类型一个合并网格"，仅生成暴露面（面
 *     剔除），修改方块时重建对应 chunk 网格。
 *  5. update(playerPos) 根据玩家位置加载/卸载 chunk，限制渲染距离。
 * 依赖：Three.js、Blocks
 * ============================================================ */

(function (global) {
    "use strict";

    const CHUNK_SIZE = 16;          // chunk 水平边长
    const WORLD_HEIGHT = 40;        // 世界垂直高度（方块数）
    const RENDER_DISTANCE = 4;      // 渲染半径（chunk 数）
    const BASE_HEIGHT = 12;         // 基准地表高度
    const SAND_RADIUS = 10;         // 中心沙质平地半径
    const SEA_LEVEL = BASE_HEIGHT;  // 海平面 / 中心平地高度

    /** 6 个面的方向（用于面剔除与几何构建） */
    const FACES = [
        { dir: [1, 0, 0], corners: [[1,1,0],[1,0,0],[1,1,1],[1,0,1]] }, // +x
        { dir: [-1, 0, 0], corners: [[0,1,1],[0,0,1],[0,1,0],[0,0,0]] },// -x
        { dir: [0, 1, 0], corners: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]] },// +y (顶)
        { dir: [0, -1, 0], corners: [[0,0,0],[1,0,0],[0,0,1],[1,0,1]] },// -y (底)
        { dir: [0, 0, 1], corners: [[1,1,1],[1,0,1],[0,1,1],[0,0,1]] },// +z
        { dir: [0, 0, -1], corners: [[0,1,0],[0,0,0],[1,1,0],[1,0,0]] },// -z
    ];

    /* ---------- 简易确定性值噪声 ---------- */
    function hash2(x, z) {
        let h = x * 374761393 + z * 668265263;
        h = (h ^ (h >> 13)) * 1274126177;
        h = h ^ (h >> 16);
        return ((h >>> 0) % 100000) / 100000;
    }
    function smooth(t) { return t * t * (3 - 2 * t); }
    function valueNoise(x, z) {
        const xi = Math.floor(x), zi = Math.floor(z);
        const xf = x - xi, zf = z - zi;
        const v00 = hash2(xi, zi), v10 = hash2(xi + 1, zi);
        const v01 = hash2(xi, zi + 1), v11 = hash2(xi + 1, zi + 1);
        const u = smooth(xf), v = smooth(zf);
        return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v;
    }
    /** 多频率叠加的分形噪声 */
    function fractal(x, z) {
        let total = 0, amp = 1, freq = 1, max = 0;
        for (let i = 0; i < 4; i++) {
            total += valueNoise(x * freq, z * freq) * amp;
            max += amp;
            amp *= 0.5;
            freq *= 2;
        }
        return total / max;
    }

    /* ---------- 世界类 ---------- */
    class World {
        constructor(scene) {
            this.scene = scene;
            this.chunks = new Map();       // key "cx,cz" -> { data:Uint8Array, meshes:[] }
            this.dirty = new Set();        // 待重建网格的 chunk key
            this.materials = Blocks.initMaterials();
        }

        /** chunk key */
        _key(cx, cz) { return cx + "," + cz; }

        /** 世界坐标 -> chunk 坐标 */
        _chunkCoord(x, z) {
            return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
        }

        /** chunk 内索引 */
        _index(lx, y, lz) {
            return (y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
        }

        /** 获取方块类型（自动生成 chunk 数据） */
        getBlock(x, y, z) {
            if (y < 0 || y >= WORLD_HEIGHT) return Blocks.BlockType.AIR;
            const [cx, cz] = this._chunkCoord(x, z);
            const chunk = this._getOrGenChunk(cx, cz);
            const lx = x - cx * CHUNK_SIZE;
            const lz = z - cz * CHUNK_SIZE;
            return chunk.data[this._index(lx, y, lz)];
        }

        /** 设置方块（破坏/放置），标记 chunk 及邻居为脏 */
        setBlock(x, y, z, type) {
            if (y < 0 || y >= WORLD_HEIGHT) return;
            const [cx, cz] = this._chunkCoord(x, z);
            const chunk = this._getOrGenChunk(cx, cz);
            const lx = x - cx * CHUNK_SIZE;
            const lz = z - cz * CHUNK_SIZE;
            chunk.data[this._index(lx, y, lz)] = type;
            this.dirty.add(this._key(cx, cz));
            // 若改动在 chunk 边界，邻居 chunk 也需重建（共享面）
            if (lx === 0) this.dirty.add(this._key(cx - 1, cz));
            if (lx === CHUNK_SIZE - 1) this.dirty.add(this._key(cx + 1, cz));
            if (lz === 0) this.dirty.add(this._key(cx, cz - 1));
            if (lz === CHUNK_SIZE - 1) this.dirty.add(this._key(cx, cz + 1));
        }

        /** 获取或生成 chunk 数据 */
        _getOrGenChunk(cx, cz) {
            const key = this._key(cx, cz);
            let chunk = this.chunks.get(key);
            if (!chunk) {
                const data = this._generateChunkData(cx, cz);
                chunk = { data, meshes: [], generated: true };
                this.chunks.set(key, chunk);
                this.dirty.add(key);
            }
            return chunk;
        }

        /**
         * 生成一个 chunk 的方块数据
         * 规则：
         *  - 中心沙质平地：距原点水平距离 < SAND_RADIUS 内，地表=沙子且高度=SEA_LEVEL
         *  - 外圈：分形噪声决定地表高度，草地+泥土+石头
         *  - 随机种树（不在沙地区域）
         */
        _generateChunkData(cx, cz) {
            const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
            const B = Blocks.BlockType;
            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    const wx = cx * CHUNK_SIZE + lx;
                    const wz = cz * CHUNK_SIZE + lz;
                    const dist = Math.sqrt(wx * wx + wz * wz);

                    // 地表高度
                    let height;
                    let isSandArea = dist < SAND_RADIUS;
                    if (isSandArea) {
                        height = SEA_LEVEL; // 中心平地
                    } else {
                        const n = fractal(wx * 0.06, wz * 0.06);
                        height = Math.floor(SEA_LEVEL + (n - 0.5) * 10);
                    }
                    if (height < 1) height = 1;
                    if (height >= WORLD_HEIGHT - 1) height = WORLD_HEIGHT - 2;

                    // 填充列
                    for (let y = 0; y <= height; y++) {
                        let t;
                        if (y === height) {
                            t = isSandArea ? B.SAND : B.GRASS;
                        } else if (y >= height - 2) {
                            t = isSandArea ? B.SAND : B.DIRT;
                        } else {
                            t = B.STONE;
                        }
                        data[this._index(lx, y, lz)] = t;
                    }

                    // 随机种树（草地、非沙地区、低概率）
                    if (!isSandArea && height < WORLD_HEIGHT - 6) {
                        if (hash2(wx * 7, wz * 13) > 0.985) {
                            this._plantTree(data, lx, height + 1, lz);
                        }
                    }
                }
            }
            return data;
        }

        /** 在 chunk 数据内种一棵小树（树干 + 树冠） */
        _plantTree(data, lx, baseY, lz) {
            const B = Blocks.BlockType;
            const trunkH = 4 + Math.floor(hash2(lx * 3, lz * 5) * 3);
            for (let i = 0; i < trunkH; i++) {
                const y = baseY + i;
                if (y < WORLD_HEIGHT) data[this._index(lx, y, lz)] = B.WOOD;
            }
            const topY = baseY + trunkH;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    for (let dz = -2; dz <= 2; dz++) {
                        if (dx === 0 && dz === 0 && dy < 1) continue;
                        const r = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
                        if (r > 3) continue;
                        const nx = lx + dx, ny = topY + dy, nz = lz + dz;
                        if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) continue;
                        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
                        if (data[this._index(nx, ny, nz)] === B.AIR) {
                            data[this._index(nx, ny, nz)] = B.LEAVES;
                        }
                    }
                }
            }
        }

        /* ---------- 网格构建 ---------- */
        /**
         * 重建单个 chunk 的网格：按方块类型分组，仅生成暴露面
         */
        _buildChunkMesh(cx, cz) {
            const chunk = this.chunks.get(this._key(cx, cz));
            if (!chunk) return;

            // 移除旧网格
            for (const m of chunk.meshes) {
                this.scene.remove(m);
                m.geometry.dispose();
            }
            chunk.meshes = [];

            // 按方块类型累积顶点数据
            const groups = {}; // type -> { pos:[], norm:[], uv:[], idx:[] }
            const B = Blocks.BlockType;

            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let y = 0; y < WORLD_HEIGHT; y++) {
                        const type = chunk.data[this._index(lx, y, lz)];
                        if (type === B.AIR) continue;
                        const wx = cx * CHUNK_SIZE + lx;
                        const wz = cz * CHUNK_SIZE + lz;
                        // 对每个面，邻居为空气则生成
                        for (let f = 0; f < 6; f++) {
                            const face = FACES[f];
                            const nx = wx + face.dir[0];
                            const ny = y + face.dir[1];
                            const nz = wz + face.dir[2];
                            if (Blocks.isSolid(this.getBlock(nx, ny, nz))) continue;
                            // 该面可见
                            if (!groups[type]) groups[type] = { pos: [], norm: [], uv: [], idx: [] };
                            const g = groups[type];
                            const base = g.pos.length / 3;
                            for (const c of face.corners) {
                                g.pos.push(wx + c[0], y + c[1], wz + c[2]);
                                g.norm.push(face.dir[0], face.dir[1], face.dir[2]);
                            }
                            // UV：四角对应整张纹理
                            const uvSet = [[0,1],[0,0],[1,1],[1,0]];
                            for (const uv of uvSet) g.uv.push(uv[0], uv[1]);
                            g.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
                        }
                    }
                }
            }

            // 为每种类型创建一个 mesh
            for (const typeStr in groups) {
                const type = parseInt(typeStr, 10);
                const g = groups[type];
                const geo = new THREE.BufferGeometry();
                geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3));
                geo.setAttribute("normal", new THREE.Float32BufferAttribute(g.norm, 3));
                geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
                geo.setIndex(g.idx);
                const material = this.materials[type];
                const mesh = new THREE.Mesh(geo, material);
                mesh.chunkKey = this._key(cx, cz);
                this.scene.add(mesh);
                chunk.meshes.push(mesh);
            }
        }

        /**
         * 每帧调用：加载玩家附近 chunk，卸载远处 chunk，重建脏 chunk
         * 限制每帧重建数量以避免卡顿
         */
        update(playerX, playerZ) {
            const [pcx, pcz] = this._chunkCoord(
                Math.floor(playerX), Math.floor(playerZ)
            );

            // 加载范围内 chunk
            for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
                for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
                    this._getOrGenChunk(pcx + dx, pcz + dz);
                }
            }

            // 重建脏 chunk（每帧最多 2 个，防卡顿）
            let rebuilt = 0;
            for (const key of this.dirty) {
                if (rebuilt >= 2) break;
                const [cx, cz] = key.split(",").map(Number);
                // 只重建在渲染范围内的
                if (Math.abs(cx - pcx) > RENDER_DISTANCE || Math.abs(cz - pcz) > RENDER_DISTANCE) {
                    this.dirty.delete(key);
                    continue;
                }
                this._buildChunkMesh(cx, cz);
                this.dirty.delete(key);
                rebuilt++;
            }

            // 卸载远处 chunk
            for (const key of Array.from(this.chunks.keys())) {
                const [cx, cz] = key.split(",").map(Number);
                if (Math.abs(cx - pcx) > RENDER_DISTANCE + 1 || Math.abs(cz - pcz) > RENDER_DISTANCE + 1) {
                    const chunk = this.chunks.get(key);
                    for (const m of chunk.meshes) {
                        this.scene.remove(m);
                        m.geometry.dispose();
                    }
                    this.chunks.delete(key);
                    this.dirty.delete(key);
                }
            }
        }

        /** 提示：强制重建某 chunk（交互后立即生效） */
        rebuildAround(x, z) {
            const [cx, cz] = this._chunkCoord(Math.floor(x), Math.floor(z));
            this.dirty.add(this._key(cx, cz));
        }
    }

    /* ---------- COZE 像素文字墙 ----------
     * 在世界中心沙质平地上、玩家出生点正前方拼出 "COZE"。
     * 玩家出生点 (0, ?, 0) 朝向 -Z，故文字墙立于 z = -WALL_DIST 处，
     * 字母沿 X 排列、Y 上下，墙面朝 +Z（面向玩家）。
     */
    const WALL_DIST = 14;             // 墙距出生点（格）
    const LETTER_W = 5, LETTER_H = 7; // 每字母像素尺寸
    const LETTER_GAP = 1;             // 字母间隔

    // 5×7 像素字母点阵（1 = 放置方块）
    const LETTERS = {
        C: [
            "01110",
            "10001",
            "10000",
            "10000",
            "10000",
            "10001",
            "01110",
        ],
        O: [
            "01110",
            "10001",
            "10001",
            "10001",
            "10001",
            "10001",
            "01110",
        ],
        Z: [
            "11111",
            "00001",
            "00010",
            "00100",
            "01000",
            "10000",
            "11111",
        ],
        E: [
            "11111",
            "10000",
            "10000",
            "11110",
            "10000",
            "10000",
            "11111",
        ],
    };

    /**
     * 在世界中拼出 COZE 文字墙
     * @param {World} world
     */
    function buildCOZEWall(world) {
        const text = "COZE";
        const totalW = text.length * LETTER_W + (text.length - 1) * LETTER_GAP;
        const startX = -Math.floor(totalW / 2);
        const z = -WALL_DIST;
        const baseY = SEA_LEVEL + 1; // 立于沙地之上

        // 1) 先在墙下方整平出一块沙地台座（覆盖噪声地形，避免遮挡文字）
        //    范围：x 覆盖整段文字 +1 格余量，z 取墙厚 ±1
        const B = Blocks.BlockType;
        for (let x = startX - 1; x <= startX + totalW; x++) {
            for (let dz = -1; dz <= 1; dz++) {
                const pz = z + dz;
                // 顶部一层设为沙子（保证平整地面）
                world.setBlock(x, SEA_LEVEL, pz, B.SAND);
                // 清除地面上方可能由噪声生成、会挡住文字的方块
                for (let y = SEA_LEVEL + 1; y <= SEA_LEVEL + 1; y++) {
                    if (Blocks.isSolid(world.getBlock(x, y, pz))) {
                        world.setBlock(x, y, pz, B.AIR);
                    }
                }
            }
        }

        // 2) 用砖块拼出 COZE 像素字母
        for (let i = 0; i < text.length; i++) {
            const glyph = LETTERS[text[i]];
            const ox = startX + i * (LETTER_W + LETTER_GAP);
            for (let row = 0; row < LETTER_H; row++) {
                for (let col = 0; col < LETTER_W; col++) {
                    if (glyph[row][col] === "1") {
                        const wx = ox + col;
                        const wy = baseY + (LETTER_H - 1 - row); // 翻转：顶部在上
                        world.setBlock(wx, wy, z, B.BRICK);
                    }
                }
            }
        }
    }

    // 暴露到全局
    global.World = World;
    global.buildCOZEWall = buildCOZEWall;
    global.WorldConstants = {
        CHUNK_SIZE,
        WORLD_HEIGHT,
        RENDER_DISTANCE,
        BASE_HEIGHT,
        SEA_LEVEL,
        SAND_RADIUS,
    };
})(window);

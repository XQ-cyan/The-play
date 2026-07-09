/* ============================================================
 * blocks.js — 方块类型定义 + 像素纹理生成
 *
 * 说明：所有纹理通过 Canvas 程序化生成（16x16 像素，放大后保持
 *       锯齿感以贴合"像素方块"美术风格），无需任何外部图片资源，
 *       单文件即可在浏览器 / 移动端直接运行。
 * 依赖：Three.js（UMD 全局 THREE）
 * ============================================================ */

(function (global) {
    "use strict";

    /** 方块类型枚举（0 = 空气，不可见不可碰撞） */
    const BlockType = {
        AIR: 0,
        GRASS: 1,   // 草地
        DIRT: 2,    // 泥土
        SAND: 3,    // 沙子（出生点中心沙质平地）
        STONE: 4,   // 石头
        WOOD: 5,    // 木头
        LEAVES: 6,  // 树叶
        BRICK: 7,   // 砖块（用于拼 COZE 文字墙）
    };

    /** 玩家手持可放置的方块（快捷栏 1~4 对应） */
    const HOTBAR_BLOCKS = [
        BlockType.GRASS,
        BlockType.SAND,
        BlockType.STONE,
        BlockType.BRICK,
    ];

    const TEX_SIZE = 16; // 纹理分辨率

    /** 简易确定性随机，保证同一方块纹理每次生成一致 */
    function makeRng(seed) {
        let s = seed >>> 0;
        return function () {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 0xffffffff;
        };
    }

    /** 在 ctx 上画 1 个像素点 */
    function px(ctx, x, y, color) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
    }

    /**
     * 生成一张基础色 + 随机噪点的像素纹理
     * @param {string} base 基础色
     * @param {string[]} noise 噪点颜色池
     * @param {number} seed 随机种子
     * @param {function} [extra] 额外绘制回调
     */
    function buildTexture(base, noise, seed, extra) {
        const canvas = document.createElement("canvas");
        canvas.width = TEX_SIZE;
        canvas.height = TEX_SIZE;
        const ctx = canvas.getContext("2d");
        const rng = makeRng(seed);

        // 先填底色
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

        // 撒噪点
        for (let y = 0; y < TEX_SIZE; y++) {
            for (let x = 0; x < TEX_SIZE; x++) {
                if (rng() < 0.35) {
                    px(ctx, x, y, noise[(rng() * noise.length) | 0]);
                }
            }
        }

        // 额外纹理（如砖纹、木纹）
        if (extra) extra(ctx, rng, px);

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter; // 放大保持像素感
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    /** 砖块纹理：横竖灰缝 + 砖体红棕 */
    function brickPattern(ctx, rng, px) {
        const mortar = "#3a2a2a";
        const brick = "#9c3b2e";
        const brickDark = "#7a2c22";
        // 每两行一砖层，错缝
        for (let y = 0; y < TEX_SIZE; y++) {
            if (y % 4 === 0) {
                // 灰缝行
                for (let x = 0; x < TEX_SIZE; x++) px(ctx, x, y, mortar);
            } else {
                const offset = (Math.floor(y / 4) % 2) * 4;
                for (let x = 0; x < TEX_SIZE; x++) {
                    if ((x + offset) % 8 === 0) px(ctx, x, y, mortar);
                    else if (rng() < 0.15) px(ctx, x, y, brickDark);
                    else px(ctx, x, y, brick);
                }
            }
        }
    }

    /** 木头纹理：竖纹 */
    function woodPattern(ctx, rng, px) {
        const dark = "#6b4a26";
        const base = "#8a5a2b";
        for (let x = 0; x < TEX_SIZE; x++) {
            if (x % 5 === 0) {
                for (let y = 0; y < TEX_SIZE; y++) px(ctx, x, y, dark);
            } else if (rng() < 0.1) {
                for (let y = 0; y < TEX_SIZE; y++) px(ctx, x, y, dark);
            } else {
                for (let y = 0; y < TEX_SIZE; y++) if (rng() < 0.2) px(ctx, x, y, dark);
            }
        }
    }

    /** 草地顶面纹理（更鲜亮的绿） */
    function grassTopPattern(ctx, rng, px) {
        const dark = "#3e8e2f";
        const light = "#6cbf3f";
        for (let y = 0; y < TEX_SIZE; y++) {
            for (let x = 0; x < TEX_SIZE; x++) {
                px(ctx, x, y, rng() < 0.5 ? dark : light);
            }
        }
    }

    let _materials = null; // 材质缓存

    /**
     * 初始化所有方块材质（懒加载，需在 THREE 可用后调用）
     * 草地使用顶/侧不同纹理（数组形式），其余方块单纹理
     */
    function initMaterials() {
        if (_materials) return _materials;

        const grassTop = buildTexture("#5aa336", ["#4a8f2a", "#6cbf3f"], 11, grassTopPattern);
        const grassSide = buildTexture("#7a5a30", ["#6b4a26", "#8a6a3a"], 12, (ctx, rng, px) => {
            // 侧面顶部画一条绿色草边
            for (let x = 0; x < TEX_SIZE; x++) {
                for (let y = 0; y < 4; y++) {
                    px(ctx, x, y, rng() < 0.5 ? "#3e8e2f" : "#6cbf3f");
                }
            }
        });
        const dirt = buildTexture("#7a5a30", ["#6b4a26", "#8a6a3a", "#5a3f20"], 13);
        const sand = buildTexture("#e6d59a", ["#d9c789", "#f0e2ab", "#c9b678"], 14);
        const stone = buildTexture("#8a8a8a", ["#6f6f6f", "#9a9a9a", "#787878"], 15);
        const wood = buildTexture("#8a5a2b", ["#6b4a26", "#9c6a35"], 16, woodPattern);
        const leaves = buildTexture("#3e8e2f", ["#2f7a22", "#4fa83a", "#256b1c"], 17);
        const brick = buildTexture("#9c3b2e", ["#7a2c22", "#b04a3a"], 18, brickPattern);

        // 网格顺序对应 BoxGeometry 的 6 个面：+x,-x,+y,-y,+z,-z
        const mat = (tex) => new THREE.MeshLambertMaterial({ map: tex });
        _materials = {};
        _materials[BlockType.GRASS] = [
            mat(grassSide), mat(grassSide), mat(grassTop), mat(dirt), mat(grassSide), mat(grassSide),
        ];
        _materials[BlockType.DIRT] = mat(dirt);
        _materials[BlockType.SAND] = mat(sand);
        _materials[BlockType.STONE] = mat(stone);
        _materials[BlockType.WOOD] = mat(wood);
        _materials[BlockType.LEAVES] = new THREE.MeshLambertMaterial({
            map: leaves,
            transparent: true,
            alphaTest: 0.1,
        });
        _materials[BlockType.BRICK] = mat(brick);
        return _materials;
    }

    /** 判断方块是否为实体（非空气，参与碰撞与渲染） */
    function isSolid(type) {
        return type !== BlockType.AIR;
    }

    // 暴露到全局命名空间 Blocks
    global.Blocks = {
        BlockType,
        HOTBAR_BLOCKS,
        initMaterials,
        isSolid,
    };
})(window);

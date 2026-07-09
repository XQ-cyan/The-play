/* ============================================================
 * game.js — 主入口：场景搭建、主循环、UI 事件绑定
 *
 * 职责：
 *  - 创建 Three.js 场景 / 相机 / 渲染器 / 灯光 / 雾 / 天空
 *  - 初始化世界与玩家，构建 COZE 文字墙，预加载出生点附近区块
 *  - 主循环（requestAnimationFrame）：更新玩家与世界、渲染、HUD
 *  - 快捷栏切换（数字键 / 点击）、开始按钮、窗口尺寸自适应
 * 依赖：Three.js、Blocks、World、Player
 * ============================================================ */

(function () {
    "use strict";

    // ---------- 检测触屏，给 body 加标记（CSS 据此切换控件） ----------
    const isTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
    if (isTouch) document.body.classList.add("touch");

    // ---------- 场景 ----------
    const scene = new THREE.Scene();
    const skyColor = new THREE.Color(0x87ceeb);
    scene.background = skyColor;
    // 雾：与渲染距离配合，远处淡入天空色
    scene.fog = new THREE.Fog(skyColor.getHex(), CHUNK_SIZE * 2, CHUNK_SIZE * WorldConstants.RENDER_DISTANCE);

    const CHUNK_SIZE = WorldConstants.CHUNK_SIZE;

    // ---------- 相机（第一人称） ----------
    const camera = new THREE.PerspectiveCamera(
        70,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.rotation.order = "YXZ";

    // ---------- 渲染器 ----------
    const renderer = new THREE.WebGLRenderer({ antialias: !isTouch });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2));
    document.getElementById("game-container").appendChild(renderer.domElement);

    // ---------- 灯光 ----------
    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(50, 80, 30);
    scene.add(sun);
    // 半球光让阴影面不至于太黑
    const hemi = new THREE.HemisphereLight(0xbfdfff, 0x556633, 0.35);
    scene.add(hemi);

    // ---------- 世界 ----------
    const world = new World(scene);
    const player = new Player(camera, world, renderer.domElement);

    // 预加载出生点附近区块：先触发一次 update 加载范围内 chunk（填入 dirty），
    // 再循环 update 直到所有脏 chunk 网格建完。
    // （update 每帧限制重建数量防卡顿，预加载阶段多跑几轮把世界填满）
    world.update(player.position.x, player.position.z);
    let preloadIter = 0;
    while (world.dirty.size > 0 && preloadIter < 500) {
        world.update(player.position.x, player.position.z);
        preloadIter++;
    }

    // 构建 COZE 像素文字墙（位于玩家出生点正前方）
    buildCOZEWall(world);
    // 文字墙改动后，再次循环重建相关 chunk
    preloadIter = 0;
    while (world.dirty.size > 0 && preloadIter < 200) {
        world.update(player.position.x, player.position.z);
        preloadIter++;
    }

    // ---------- UI：开始按钮 ----------
    const startScreen = document.getElementById("start-screen");
    const startBtn = document.getElementById("start-btn");
    const crosshair = document.getElementById("crosshair");
    const loading = document.getElementById("loading");
    loading.style.display = "none";

    let started = false;
    function startGame() {
        started = true;
        startScreen.classList.add("hidden");
        crosshair.classList.add("visible");
        // 桌面端请求指针锁
        if (!isTouch) {
            renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock();
        }
    }
    startBtn.addEventListener("click", startGame);

    // ---------- UI：快捷栏选中方块 ----------
    let selectedBlock = Blocks.HOTBAR_BLOCKS[0];
    const slots = document.querySelectorAll("#hotbar .slot");
    function selectSlot(index) {
        selectedBlock = Blocks.HOTBAR_BLOCKS[index];
        slots.forEach((s, i) => s.classList.toggle("active", i === index));
    }
    slots.forEach((s, i) => {
        s.addEventListener("click", () => selectSlot(i));
        s.addEventListener("touchstart", (e) => { selectSlot(i); e.preventDefault(); }, { passive: false });
    });
    // 桌面端数字键切换
    window.addEventListener("keydown", (e) => {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= Blocks.HOTBAR_BLOCKS.length) selectSlot(n - 1);
    });
    // 桌面端滚轮也能切换
    window.addEventListener("wheel", (e) => {
        if (!started) return;
        let idx = Blocks.HOTBAR_BLOCKS.indexOf(selectedBlock);
        idx = (idx + (e.deltaY > 0 ? 1 : -1) + Blocks.HOTBAR_BLOCKS.length) % Blocks.HOTBAR_BLOCKS.length;
        selectSlot(idx);
    });

    // 让 placeBlock 默认用 selectedBlock：覆盖 player.placeBlock
    const _place = player.placeBlock.bind(player);
    player.placeBlock = function () { _place(selectedBlock); };

    // ---------- 主循环 ----------
    const hud = document.getElementById("hud");
    let lastTime = performance.now();
    let frameCount = 0, fpsTimer = 0, fps = 0;

    function loop(now) {
        requestAnimationFrame(loop);
        let dt = (now - lastTime) / 1000;
        lastTime = now;
        if (dt > 0.1) dt = 0.1; // 防止切后台后大跳变

        if (started) {
            player.update(dt);
            world.update(player.position.x, player.position.z);
        }
        renderer.render(scene, camera);

        // HUD：FPS + 坐标
        frameCount++;
        fpsTimer += dt;
        if (fpsTimer >= 0.5) {
            fps = Math.round(frameCount / fpsTimer);
            frameCount = 0;
            fpsTimer = 0;
            hud.textContent =
                `FPS: ${fps}\n` +
                `XYZ: ${player.position.x.toFixed(1)} ${player.position.y.toFixed(1)} ${player.position.z.toFixed(1)}`;
        }
    }
    requestAnimationFrame(loop);

    // ---------- 窗口尺寸自适应 ----------
    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // 暴露调试句柄（可选）
    window.__game = { scene, camera, renderer, world, player };
})();

// ==UserScript==
// @name         小红书AI神评助手
// @namespace    http://tampermonkey.net/
// @version      15.29
// @description  [Hook] 自动评论(接入流式AI或固定语料)|强力穿透点赞收藏|视频自动下载|边滑边点展开|导出后清理内存|全节点气泡通知|标题固定不滚动|记录已评历史防重复
// @author       JHC000abc@gmail.com
// @license      CC BY-NC-SA 4.0
// @match        https://www.xiaohongshu.com/*
// @match        https://edith.xiaohongshu.com/*
// @connect      127.0.0.1
// @connect      *
// @require      https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_download
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const realWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ================= 1. 配置与状态管理 =================
    const DEFAULTS = {
        enabled: true,
        darkMode: false,

        // 交互相关
        interactEnabled: false,
        likeRate: 50,
        collectRate: 30,

        // 评论相关
        commentEnabled: false,
        commentRate: 100,
        streamEnabled: true,    // 默认开启流式输出

        // 数据录制与采集策略
        recordingEnabled: false,
        autoExport: false,      // 自动导出（静默完成后触发）
        scrollMain: false,      // 自动下滑加载
        autoExpand: false,      // 自动展开子评论
        autoDlVideo: false,     // 自动下载视频

        // Motrix
        motrixEnabled: false,
        motrixUrl: "http://127.0.0.1:16800/jsonrpc",
        motrixKey: "",

        // Hook
        logHooks: false,

        // 内容生成源: local | online | fixed
        aiSource: "local",

        // 固定语料
        fixedComments: "666\n学到了\n博主真棒\n蹲一个\n太强了\n已收藏\n干货满满",

        localUrl: "http://127.0.0.1:11434/api/generate",
        localModel: "deepseek-r1:1.5b",
        onlineUrl: "https://api.deepseek.com/chat/completions",
        onlineModel: "deepseek-chat",
        onlineKey: "",

        systemPrompt: "你是一个小红书毒舌神评手。请结合【笔记信息】和【网友热评】，寻找刁钻角度或神转折。生成一条回复：1. 严格限制在30-60字之间。2. 风格要‘损’（调侃）、幽默、接地气。3. 直接输出内容。",
        timeoutSeconds: 60
    };

    const MEMORY_LIMIT = 200;
    const HISTORY_LIMIT = 100; // 历史记录最大条数

    // 全局数据池
    if (!realWin.dy_record_map) {
        realWin.dy_record_map = new Map();
    }

    // 运行时状态
    const STATE = {
        isProcessing: false,
        currentNoteId: null,
        interactedNoteId: null, // 记录已执行过交互的笔记ID
        capturedNote: null,
        capturedComments: [],
        panelVisible: false,
        hasAutoCommented: false,

        // 采集流控制
        taskTimer: null,
        lastScrollHeight: 0,
        scrollStableCount: 0,
        isManualTask: false,
        statusText: "待机中",

        // 下载去重
        downloadedVideoIds: new Set()
    };

    const COLORS = {
        IDLE: 'rgb(0, 123, 255)',
        PROCESSING: 'rgb(255, 193, 7)',
        SUCCESS: 'rgb(46, 204, 113)',
        ERROR: 'rgb(231, 76, 60)',
        RECORD: 'rgb(255, 71, 87)',
        INTERACT: 'rgb(225, 112, 85)',
        DOWNLOAD: 'rgb(108, 92, 231)',
        HISTORY: 'rgb(108, 92, 231)' // 历史记录颜色
    };

    // ================= 2. 辅助函数 =================
    function getSettings() {
        return {
            enabled: GM_getValue('xhs_enabled', DEFAULTS.enabled),
            darkMode: GM_getValue('xhs_darkMode', DEFAULTS.darkMode),

            interactEnabled: GM_getValue('xhs_interactEnabled', DEFAULTS.interactEnabled),
            likeRate: parseInt(GM_getValue('xhs_likeRate', DEFAULTS.likeRate)),
            collectRate: parseInt(GM_getValue('xhs_collectRate', DEFAULTS.collectRate)),

            commentEnabled: GM_getValue('xhs_commentEnabled', DEFAULTS.commentEnabled),
            commentRate: parseInt(GM_getValue('xhs_commentRate', DEFAULTS.commentRate)),
            streamEnabled: GM_getValue('xhs_streamEnabled', DEFAULTS.streamEnabled),

            recordingEnabled: GM_getValue('xhs_recordingEnabled', DEFAULTS.recordingEnabled),
            autoExport: GM_getValue('xhs_autoExport', DEFAULTS.autoExport),
            scrollMain: GM_getValue('xhs_scrollMain', DEFAULTS.scrollMain),
            autoExpand: GM_getValue('xhs_autoExpand', DEFAULTS.autoExpand),
            autoDlVideo: GM_getValue('xhs_autoDlVideo', DEFAULTS.autoDlVideo),

            motrixEnabled: GM_getValue('xhs_motrixEnabled', DEFAULTS.motrixEnabled),
            motrixUrl: GM_getValue('xhs_motrixUrl', DEFAULTS.motrixUrl),
            motrixKey: GM_getValue('xhs_motrixKey', DEFAULTS.motrixKey),

            logHooks: GM_getValue('xhs_logHooks', DEFAULTS.logHooks),

            aiSource: GM_getValue('xhs_aiSource', DEFAULTS.aiSource),
            fixedComments: GM_getValue('xhs_fixedComments', DEFAULTS.fixedComments),

            localUrl: GM_getValue('xhs_localUrl', DEFAULTS.localUrl),
            localModel: GM_getValue('xhs_localModel', DEFAULTS.localModel),
            onlineUrl: GM_getValue('xhs_onlineUrl', DEFAULTS.onlineUrl),
            onlineModel: GM_getValue('xhs_onlineModel', DEFAULTS.onlineModel),
            onlineKey: GM_getValue('xhs_onlineKey', DEFAULTS.onlineKey),
            systemPrompt: GM_getValue('xhs_systemPrompt', DEFAULTS.systemPrompt),
            timeoutSeconds: parseInt(GM_getValue('xhs_timeoutSeconds', DEFAULTS.timeoutSeconds))
        };
    }

    function saveSettings(settings) {
        for (const key in settings) {
            GM_setValue(`xhs_${key}`, settings[key]);
        }
        showToast("💾 设置保存成功", "所有配置项已更新并生效。\n部分Hook相关设置刷新页面后完全应用。", COLORS.SUCCESS);
    }

    function formatTime(ts) {
        if (!ts) return "";
        const date = new Date(ts);
        return date.toLocaleString('zh-CN', { hour12: false });
    }

    function getVal(obj, ...keys) {
        if (!obj) return undefined;
        for (let key of keys) {
            if (obj[key] !== undefined) return obj[key];
            const snake = key.replace(/([A-Z])/g, "_$1").toLowerCase();
            if (obj[snake] !== undefined) return obj[snake];
        }
        return undefined;
    }

    function isCurrentUrlMatch(id) {
        if (!id) return false;
        return window.location.href.indexOf(String(id)) > -1;
    }

    // 内存管理
    function manageMemory() {
        if (realWin.dy_record_map.size > MEMORY_LIMIT) {
            const oldestKey = realWin.dy_record_map.keys().next().value;
            realWin.dy_record_map.delete(oldestKey);
        }
    }

    function getRecord(noteId) {
        const strId = String(noteId);
        if (!realWin.dy_record_map.has(strId)) {
            realWin.dy_record_map.set(strId, {
                detail: null,
                comments: [],
                commentIds: new Set()
            });
            manageMemory();
        }
        return realWin.dy_record_map.get(strId);
    }

    // ================= 2.1 历史记录管理 (新功能) =================
    // 获取已评论历史列表
    function getHistory() {
        let history = GM_getValue('xhs_comment_history', []);
        // 兼容性处理，确保是数组
        if (!Array.isArray(history)) {
            history = [];
        }
        return history;
    }

    // 添加到历史记录
    function addHistory(noteId) {
        if (!noteId) return;
        const strId = String(noteId);
        let history = getHistory();

        // 如果已存在，先移除（为了放到末尾更新时间，或者保持FIFO，这里选择不重复添加）
        // 需求是保留100条，超过删除前面的。
        if (!history.includes(strId)) {
            history.push(strId);
            if (history.length > HISTORY_LIMIT) {
                history.shift(); // 删除最旧的
            }
            GM_setValue('xhs_comment_history', history);
            console.log(`[XHS-Bot] 📜 历史记录已更新，当前条数: ${history.length}, 新增: ${strId}`);
        }
    }

    // 检查是否在历史记录中
    function checkInHistory(noteId) {
        if (!noteId) return false;
        const history = getHistory();
        return history.includes(String(noteId));
    }

    // [New] 强力点击函数（保留该函数以防其他地方使用）
    function triggerComplexClick(element) {
        if (!element) return;

        try {
            const commonOpts = {
                bubbles: true,
                cancelable: true,
                view: unsafeWindow,
                detail: 1,
                buttons: 1,
                pointerId: 1,
                width: 1,
                height: 1,
                pressure: 0.5,
                isPrimary: true
            };

            const eventTypes = [
                { type: 'pointerover', class: PointerEvent },
                { type: 'pointerenter', class: PointerEvent },
                { type: 'mouseover', class: MouseEvent },
                { type: 'pointerdown', class: PointerEvent },
                { type: 'mousedown', class: MouseEvent },
                { type: 'pointerup', class: PointerEvent },
                { type: 'mouseup', class: MouseEvent },
                { type: 'click', class: PointerEvent }
            ];

            eventTypes.forEach(evt => {
                const event = new evt.class(evt.type, commonOpts);
                element.dispatchEvent(event);
            });

        } catch (e) {
            console.error("[XHS-Bot] Complex Click Failed:", e);
            element.click();
            showToast("⚠️ 点击模拟异常", "尝试执行降级点击，可能影响交互成功率。", COLORS.ERROR);
        }
    }

    // ================= 3. 核心调度逻辑 (Task Scheduler) =================

    function triggerTaskSchedule(isManualTrigger = false) {
        if (isManualTrigger) {
            STATE.isManualTask = true;
            STATE.scrollStableCount = 0;
            showToast("🚀 任务启动", "正在执行混合采集任务...\n包含: 下滑加载 / 展开评论 / 视频下载", COLORS.PROCESSING);
        }

        const settings = getSettings();
        if (!settings.recordingEnabled && !isManualTrigger) return;
        if (!isManualTrigger && !settings.autoExport && !settings.scrollMain && !settings.autoExpand) return;
        if (!STATE.currentNoteId || !isCurrentUrlMatch(STATE.currentNoteId)) return;

        if (STATE.taskTimer) clearTimeout(STATE.taskTimer);

        const waitTime = (settings.scrollMain || settings.autoExpand) ? 1500 : 4000;

        STATE.taskTimer = setTimeout(() => {
            executeTaskCycle(settings);
        }, waitTime);
    }

    function executeTaskCycle(settings) {
        let actionTaken = false;

        if (settings.autoExpand) {
            const hasClicked = tryExpandVisibleSubComments();
            if (hasClicked) {
                STATE.statusText = "正在展开回复...";
                updateRecordStats();
                actionTaken = true;
                showToast("📂 自动操作", "检测到折叠评论，已自动执行展开点击。", COLORS.PROCESSING);
                return;
            }
        }

        if (settings.scrollMain) {
            const scrollStatus = tryScrollPage();
            if (scrollStatus === 'SCROLLING') {
                STATE.statusText = "正在下滑加载...";
                updateRecordStats();
                actionTaken = true;
                STATE.taskTimer = setTimeout(() => triggerTaskSchedule(false), 1200);
                return;
            } else if (scrollStatus === 'FINISHED') {
                console.log("[XHS-Bot] 页面似乎已到底部");
                showToast("✅ 滚动结束", "页面判定已到达底部或长时间未加载新内容。", COLORS.SUCCESS);
            }
        }

        if (!actionTaken) {
            if (STATE.isManualTask || settings.autoExport) {
                STATE.statusText = "采集完成，导出中";
                updateRecordStats();
                console.log("[XHS-Bot] 采集任务全部完成，执行导出。");
                exportToExcel(false);
                STATE.isManualTask = false;
            }
        }
    }

    function tryExpandVisibleSubComments() {
        const moreBtns = Array.from(document.querySelectorAll('.comments-container .show-more, .reply-container .show-more'));
        const validBtns = moreBtns.filter(btn =>
            btn.offsetParent !== null &&
            btn.innerText &&
            !btn.innerText.includes('收起')
        );

        if (validBtns.length > 0) {
            const btn = validBtns[0];
            btn.scrollIntoView({ behavior: "smooth", block: "center" });
            setTimeout(() => { btn.click(); }, 300);
            return true;
        }
        return false;
    }

    function tryScrollPage() {
        const scroller = document.querySelector('.note-scroller') || document.documentElement;
        const currentHeight = scroller.scrollHeight;
        const currentScroll = scroller.scrollTop + scroller.clientHeight;

        if (currentHeight - currentScroll < 50) {
            if (STATE.lastScrollHeight === currentHeight) {
                STATE.scrollStableCount++;
            } else {
                STATE.scrollStableCount = 0;
            }
            STATE.lastScrollHeight = currentHeight;

            if (STATE.scrollStableCount >= 4) {
                return 'FINISHED';
            }
        } else {
            STATE.scrollStableCount = 0;
            STATE.lastScrollHeight = currentHeight;
        }

        if (document.querySelector('.note-scroller')) {
            document.querySelector('.note-scroller').scrollTop += 600;
        } else {
            window.scrollBy(0, 600);
        }

        return 'SCROLLING';
    }

    // ================= 4. 数据解析、交互、下载与录制 =================

    function scanInitialState() {
        const settings = getSettings();
        if (!settings.recordingEnabled) return;

        let initialState = realWin.__INITIAL_STATE__ || unsafeWindow.__INITIAL_STATE__;

        if (!initialState) {
            const scripts = document.querySelectorAll('script');
            for (let script of scripts) {
                const content = script.textContent;
                if (content && content.includes('window.__INITIAL_STATE__')) {
                    try {
                        const match = content.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?/);
                        if (match && match[1]) {
                            const jsonStr = match[1].replace(/undefined/g, 'null');
                            initialState = JSON.parse(jsonStr);
                            if (settings.logHooks) {
                                console.log("🔥 [InitialState Parsed]", initialState);
                                showToast("🔍 初始化数据", "成功从页面脚本中提取 InitialState 数据。", COLORS.IDLE);
                            }
                            break;
                        }
                    } catch (e) {
                        console.error("[XHS-Bot] InitialState Parse Error:", e);
                    }
                }
            }
        }

        if (initialState) {
            try {
                let found = 0;
                if (initialState.note && initialState.note.noteDetailMap) {
                    Object.values(initialState.note.noteDetailMap).forEach(detail => {
                        if (detail && detail.note) {
                            processNoteData(detail.note);
                            found++;
                        }
                    });
                }
                if (initialState.feed && initialState.feed.feeds && Array.isArray(initialState.feed.feeds)) {
                    initialState.feed.feeds.forEach(item => {
                        if (item.note_card) {
                            processNoteData(item.note_card);
                            found++;
                        }
                    });
                }
                if (initialState.search && initialState.search.feeds && Array.isArray(initialState.search.feeds)) {
                    initialState.search.feeds.forEach(item => {
                        if (item.note_card) {
                            processNoteData(item.note_card);
                            found++;
                        }
                    });
                }
            } catch (e) {
                console.warn("[XHS-Bot] Scan Initial State Partial Error", e);
                showToast("⚠️ 初始化解析部分失败", e.message, COLORS.ERROR);
            }
        }
    }

    function tryAutoInteract() {
        const settings = getSettings();
        if (!settings.enabled || !settings.interactEnabled) return;
        if (STATE.interactedNoteId === STATE.currentNoteId) return;

        // [Check] 历史记录检查
        if (checkInHistory(STATE.currentNoteId)) {
            console.log(`[XHS-Bot] ⛔ 笔记 ${STATE.currentNoteId} 在历史记录中，跳过自动交互。`);
            showToast("⛔ 已跳过交互", "检测到该笔记已在历史记录中 (已评论过)。", COLORS.HISTORY);
            STATE.interactedNoteId = STATE.currentNoteId; // 标记为已处理防止重复检测
            return;
        }

        STATE.interactedNoteId = STATE.currentNoteId;
        console.log(`[XHS-Bot] 准备执行自动交互 (Note: ${STATE.currentNoteId})`);

        setTimeout(() => {
            // --- 1. 协议自动点赞逻辑 (底层API调用) ---
            const LIKE_SELECTORS = [
                '.left .like-wrapper .like-lottie',   // 优先：左侧操作栏 -> 动画层
                '.left .like-wrapper',                // 备选：左侧操作栏 -> 按钮本体
                '.interact-container .like-wrapper',  // 备选：通用交互容器
                '[class*="note-container"] .like-wrapper' // 备选：笔记容器内的点赞
            ];

            let likeWrapper = null;
            let foundSelector = "";

            // 寻找最佳DOM目标仅用于状态判断
            for (const selector of LIKE_SELECTORS) {
                const el = document.querySelector(selector);
                if (el && el.offsetParent !== null) {
                    likeWrapper = el;
                    foundSelector = selector;
                    break;
                }
            }

            if (likeWrapper) {
                const wrapperParent = likeWrapper.closest('.like-wrapper') || likeWrapper;
                const iconSymbol = wrapperParent.querySelector('svg use');
                let href = "";
                if (iconSymbol) {
                    href = iconSymbol.getAttribute('xlink:href') || iconSymbol.getAttribute('href') || "";
                }

                const isLikedByIcon = href.includes('#like_fill') || href.includes('#liked');
                const computedColor = window.getComputedStyle(wrapperParent).color;
                const isRed = computedColor.includes('255, 36, 66') || computedColor.includes('255, 36, 65');

                const isLiked = isLikedByIcon || isRed;

                if (!isLiked) {
                    const randomLike = Math.floor(Math.random() * 100) + 1;
                    console.log(`randomLike:${randomLike} settings.likeRate:${settings.likeRate}`);
                    if (randomLike <= settings.likeRate) {
                        const delay = Math.floor(Math.random() * 4000) + 1000;
                        console.log(`[XHS-Bot] 🎲 协议点赞命中 (${randomLike}% <= ${settings.likeRate}%)，等待 ${delay}ms 后执行...`);

                        setTimeout(() => {
                            simulateLikeNote(STATE.currentNoteId);
                            showToast("⚡️ 协议点赞", `概率命中，延迟 ${delay}ms 后已通过底层接口执行。`, COLORS.INTERACT);
                        }, delay);
                    }
                } else {
                    console.log(`[XHS-Bot] ⚠️ 检测到已点赞，跳过`);
                    showToast("ℹ️ 跳过点赞", "检测到当前笔记已经是点赞状态。", COLORS.IDLE);
                }
            } else {
                console.log("[XHS-Bot] ⚠️ 未找到可见的点赞按钮");
            }

            // --- 2. 协议自动收藏逻辑 (底层API调用) ---
            const allCollectBtns = Array.from(document.querySelectorAll('.collect-wrapper, #note-page-collect-board-guide'));
            const collectWrapper = allCollectBtns.find(el => el.offsetParent !== null);

            if (collectWrapper) {
                const iconSymbolC = collectWrapper.querySelector('svg use');
                let hrefC = "";
                if (iconSymbolC) {
                    hrefC = iconSymbolC.getAttribute('xlink:href') || iconSymbolC.getAttribute('href') || "";
                }

                const isCollectedByIcon = hrefC.includes('#collected') || hrefC.includes('#collect_fill');
                const hasClassCollected = collectWrapper.classList.contains('active') || collectWrapper.classList.contains('collected');

                const isCollected = isCollectedByIcon || hasClassCollected;

                if (!isCollected) {
                    const randomCollect = Math.floor(Math.random() * 100) + 1;
                    if (randomCollect <= settings.collectRate) {
                        const delay = Math.floor(Math.random() * 4000) + 1000;
                        console.log(`[XHS-Bot] 🎲 协议收藏命中 (${randomCollect} <= ${settings.collectRate})，等待 ${delay}ms 后执行...`);

                        setTimeout(() => {
                            simulateCollectNote(STATE.currentNoteId);
                            showToast("⭐ 协议收藏", `概率命中，延迟 ${delay}ms 后已通过底层接口执行。`, COLORS.INTERACT);
                        }, delay);
                    }
                } else {
                    console.log(`[XHS-Bot] ⚠️ 检测到已收藏，跳过`);
                    showToast("ℹ️ 跳过收藏", "检测到当前笔记已经是收藏状态。", COLORS.IDLE);
                }
            }

        }, 2500);
    }

    function handleVideoDownload(url, title, noteId) {
        const settings = getSettings();
        if (!settings.autoDlVideo || !url) return;
        if (STATE.downloadedVideoIds.has(noteId)) return;

        STATE.downloadedVideoIds.add(noteId);

        let safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").substring(0, 50) || "video";
        let filename = `${noteId}_${safeTitle}.mp4`;

        console.log(`[XHS-Bot] 🎬 触发视频下载: ${filename}`);
        showToast("⬇️ 开始下载", `正在启动视频下载任务...\n文件名: ${filename}`, COLORS.DOWNLOAD);

        if (settings.motrixEnabled) {
            const rpcPayload = {
                jsonrpc: '2.0',
                method: 'aria2.addUri',
                id: Date.now(),
                params: []
            };

            if (settings.motrixKey) {
                rpcPayload.params.push(`token:${settings.motrixKey}`);
            }
            rpcPayload.params.push([url]);
            rpcPayload.params.push({ out: filename });

            GM_xmlhttpRequest({
                method: "POST",
                url: settings.motrixUrl,
                data: JSON.stringify(rpcPayload),
                headers: { "Content-Type": "application/json" },
                onload: (res) => {
                    if (res.status === 200) {
                        showToast("✅ Motrix 推送成功", `视频任务已发送至 Motrix。\n文件: ${filename}`, COLORS.SUCCESS);
                    } else {
                        showToast("❌ Motrix 推送失败", `服务器响应状态码: ${res.status}。\n请检查Motrix是否运行及配置是否正确。`, COLORS.ERROR);
                    }
                },
                onerror: () => showToast("❌ Motrix 连接错误", "无法连接到 Motrix RPC 服务器，请检查地址和端口。", COLORS.ERROR)
            });
        } else {
            GM_download({
                url: url,
                name: filename,
                saveAs: false,
                onload: () => {
                    showToast("✅ 浏览器下载完成", `视频已下载到默认文件夹。\n文件: ${filename}`, COLORS.SUCCESS);
                },
                onerror: (e) => {
                    console.error("Download Error", e);
                    showToast("❌ 下载任务失败", `GM_download 遇到错误。\n详情: ${JSON.stringify(e)}`, COLORS.ERROR);
                }
            });
        }
    }

    function processNoteData(note) {
        const settings = getSettings();
        if (!settings.recordingEnabled || !note) return;

        const noteId = getVal(note, 'noteId', 'id', 'note_id');
        if (!noteId) return;
        const strId = String(noteId);

        if (!isCurrentUrlMatch(strId)) return;

        const recordEntry = getRecord(strId);
        if (recordEntry.detail) return;

        const interact = getVal(note, 'interactInfo', 'interact_info') || {};
        const user = getVal(note, 'user', 'user_info') || {};

        const userId = getVal(user, 'userId', 'user_id', 'id');
        const userLink = userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : "";
        const userAvatar = getVal(user, 'avatar', 'images', 'image');

        let tags = "";
        const tagList = getVal(note, 'tagList', 'tag_list');
        if (tagList && Array.isArray(tagList)) {
            tags = tagList.map(t => t.name).join(', ');
        }

        let coverUrl = "";
        let allImagesStr = "";
        const imageList = getVal(note, 'imageList', 'image_list', 'imagesList');

        if (imageList && Array.isArray(imageList) && imageList.length > 0) {
            coverUrl = getVal(imageList[0], 'urlDefault', 'url_default', 'urlPre', 'url_pre', 'url');
            const allUrls = imageList.map(img => {
                return getVal(img, 'urlDefault', 'url_default', 'urlPre', 'url_pre', 'url');
            }).filter(url => !!url);
            if (allUrls.length > 0) {
                allImagesStr = allUrls.join(' | ');
            }
        }

        if (!coverUrl) {
            const cover = getVal(note, 'cover');
            if (cover) {
                coverUrl = getVal(cover, 'urlDefault', 'url_default', 'url');
            }
        }

        let videoUrl = "";
        let videoFormat = "";
        let videoDuration = 0;
        let videoResolution = "";

        const type = getVal(note, 'type', 'model_type') || "normal";
        const videoObj = getVal(note, 'video');

        if ((type === 'video' || videoObj)) {
            if (videoObj) {
                const media = getVal(videoObj, 'media');
                let allStreams = [];

                if (media) {
                    const streamObj = getVal(media, 'stream');
                    if (streamObj) {
                        ['h264', 'h265', 'h266', 'av1'].forEach(codec => {
                            const streams = streamObj[codec];
                            if (Array.isArray(streams)) {
                                streams.forEach(s => { s._codec = codec; allStreams.push(s); });
                            }
                        });
                    }
                }

                if (allStreams.length > 0) {
                    allStreams.sort((a, b) => {
                        const wA = getVal(a, 'width') || 0;
                        const hA = getVal(a, 'height') || 0;
                        const wB = getVal(b, 'width') || 0;
                        const hB = getVal(b, 'height') || 0;
                        const resA = wA * hA;
                        const resB = wB * hB;
                        if (resB !== resA) return resB - resA;
                        return (getVal(b, 'size') || 0) - (getVal(a, 'size') || 0);
                    });

                    const best = allStreams[0];
                    videoUrl = getVal(best, 'masterUrl', 'master_url');
                    videoFormat = getVal(best, 'format') || "mp4";
                    const dur = getVal(best, 'duration');
                    videoDuration = dur ? (dur / 1000).toFixed(2) : 0;
                    videoResolution = `${getVal(best, 'width')}x${getVal(best, 'height')} (${best._codec})`;
                }

                if (!videoUrl) {
                    const consumer = getVal(videoObj, 'consumer');
                    if (consumer) {
                        const origin = getVal(consumer, 'originVideoKey', 'origin_video_key');
                        if (origin) {
                            videoUrl = getVal(origin, 'url');
                            videoResolution = "Unknown (Consumer)";
                        }
                    }
                }
            }
        }

        const title = getVal(note, 'title') || "";

        if (type === 'video' && videoUrl) {
            handleVideoDownload(videoUrl, title, strId);
        }

        const detailData = {
            "笔记ID": strId,
            "笔记类型": type,
            "标题": title,
            "文案": (getVal(note, 'desc') || "").replace(/[\r\n]+/g, ' '),
            "发布时间": formatTime(getVal(note, 'time', 'createTime', 'create_time')),
            "最后更新": formatTime(getVal(note, 'lastUpdateTime', 'last_update_time')),
            "作者昵称": getVal(user, 'nickname') || "",
            "作者ID": userId || "",
            "作者主页": userLink,
            "作者头像": userAvatar || "",
            "点赞数": getVal(interact, 'likedCount', 'liked_count') || "0",
            "收藏数": getVal(interact, 'collectedCount', 'collected_count') || "0",
            "评论数": getVal(interact, 'commentCount', 'comment_count') || "0",
            "分享数": getVal(interact, 'shareCount', 'share_count') || "0",
            "IP属地": getVal(note, 'ipLocation', 'ip_location') || "",
            "标签": tags,
            "首图/封面链接": coverUrl,
            "图片列表": allImagesStr,
            "视频链接": videoUrl,
            "视频分辨率": videoResolution,
            "视频时长(秒)": videoDuration,
            "视频格式": videoFormat
        };

        recordEntry.detail = detailData;
        STATE.currentNoteId = strId;
        updateRecordStats();
        triggerTaskSchedule(false);
        showToast("📥 笔记数据录入", `已成功抓取并记录笔记详情。\n标题: ${title.substring(0, 20)}...`, COLORS.RECORD);
    }

    function parseAndRecordComments(globalNoteId, comments, parentId = "") {
        const settings = getSettings();
        if (!settings.recordingEnabled) return;

        let hasNew = false;
        comments.forEach(c => {
            const realNoteId = getVal(c, 'noteId', 'note_id') || globalNoteId || "";
            const strId = String(realNoteId);

            if (!isCurrentUrlMatch(strId)) return;

            const recordEntry = getRecord(strId);

            const cid = getVal(c, 'id');
            if (recordEntry.commentIds.has(cid)) return;

            let picUrlList = [];
            const pictures = getVal(c, 'pictures');
            if (pictures && Array.isArray(pictures)) {
                pictures.forEach(p => {
                    const url = getVal(p, 'urlDefault', 'url_default', 'urlPre', 'url_pre', 'url');
                    if (url) picUrlList.push(url);
                });
            }
            const picUrlStr = picUrlList.join(' | ');

            const userInfo = getVal(c, 'userInfo', 'user_info') || {};
            const userId = getVal(userInfo, 'userId', 'user_id');
            const userLink = userId ? `https://www.xia红书.com/user/profile/${userId}` : "";

            const isSubReply = !!parentId;
            const targetComment = getVal(c, 'targetComment', 'target_comment');

            const mainRecord = {
                "笔记ID": strId,
                "评论ID": cid,
                "评论内容": getVal(c, 'content') || "",
                "用户昵称": getVal(userInfo, 'nickname') || "",
                "用户ID": userId || "",
                "用户主页": userLink,
                "点赞数": getVal(c, 'likeCount', 'like_count') || "0",
                "发布时间": formatTime(getVal(c, 'createTime', 'create_time')),
                "IP属地": getVal(c, 'ipLocation', 'ip_location') || "",
                "评论图片": picUrlStr,
                "评论层级": isSubReply ? "子评论" : "主评论",
                "父评论ID": parentId || (targetComment ? getVal(targetComment, 'id') : "")
            };

            recordEntry.comments.push(mainRecord);
            recordEntry.commentIds.add(cid);
            hasNew = true;

            const subComments = getVal(c, 'subComments', 'sub_comments');
            if (subComments && subComments.length > 0) {
                parseAndRecordComments(realNoteId, subComments, cid);
            }
        });

        if (hasNew) {
            updateRecordStats();
            triggerTaskSchedule(false);
        }
    }

    function updateRecordStats() {
        const elComment = document.getElementById('val-recorded-count');
        const elNote = document.getElementById('val-recorded-note-count');
        const elStatus = document.getElementById('val-status-text');

        if (elComment || elNote) {
            let totalNotes = realWin.dy_record_map.size;
            let totalComments = 0;
            realWin.dy_record_map.forEach(v => totalComments += v.comments.length);

            if (elComment) elComment.innerText = totalComments;
            if (elNote) elNote.innerText = totalNotes;
            if (elStatus) elStatus.innerText = STATE.statusText;
        }
    }

    // ================= 5. 导出逻辑 (自动清理) =================

    function exportToExcel(isSingle = false) {
        if (realWin.dy_record_map.size === 0) {
            if (!isSingle) showToast("⚠️ 导出失败", "内存中暂无任何数据可供导出。\n请先浏览页面采集数据。", COLORS.ERROR);
            return;
        }

        const settings = getSettings();
        if (settings.motrixEnabled && !isSingle) {
            showToast("⚠️ 导出提示", "Excel导出功能不支持Motrix，已自动切换为浏览器下载方式。", COLORS.PROCESSING);
        }

        try {
            const wb = XLSX.utils.book_new();
            let allNotes = [];
            let allComments = [];
            let fileName = "";
            let idsToRemove = [];

            if (isSingle) {
                const targetId = STATE.currentNoteId;
                if (!targetId || !realWin.dy_record_map.has(targetId)) return;

                const record = realWin.dy_record_map.get(targetId);
                if (record.detail) allNotes.push(record.detail);
                if (record.comments) allComments.push(...record.comments);

                let title = (record.detail && record.detail["标题"]) ? record.detail["标题"] : "无标题";
                title = title.slice(0, 15).replace(/[\\/:*?"<>|]/g, "_");
                fileName = `${targetId}_${title}.xlsx`;

                idsToRemove.push(targetId);

            } else {
                realWin.dy_record_map.forEach((record, noteId) => {
                    const hasDetail = !!record.detail;
                    const hasComments = record.comments && record.comments.length > 0;

                    if (hasDetail || hasComments) {
                        if (hasDetail) allNotes.push(record.detail);
                        if (hasComments) allComments.push(...record.comments);
                        idsToRemove.push(noteId);
                    }
                });

                const timeStr = new Date().toISOString().slice(0, 19).replace(/T|:/g, '-');
                fileName = `小红书汇总数据_${timeStr}_包含${allNotes.length}篇.xlsx`;
            }

            if (allNotes.length === 0 && allComments.length === 0) {
                if (!isSingle) showToast("⚠️ 数据无效", "没有有效的笔记或评论数据被导出。", COLORS.ERROR);
                return;
            }

            if (allNotes.length > 0) {
                const wsNotes = XLSX.utils.json_to_sheet(JSON.parse(JSON.stringify(allNotes)));
                XLSX.utils.book_append_sheet(wb, wsNotes, "笔记详情汇总");
            }

            if (allComments.length > 0) {
                const wsComments = XLSX.utils.json_to_sheet(JSON.parse(JSON.stringify(allComments)));
                XLSX.utils.book_append_sheet(wb, wsComments, "评论数据汇总");
            }

            XLSX.writeFile(wb, fileName);

            idsToRemove.forEach(id => {
                realWin.dy_record_map.delete(id);
            });
            showToast("✅ 自动导出成功", `数据已导出文件: ${fileName}\n同时已清理 ${idsToRemove.length} 条内存记录。`, COLORS.SUCCESS);
            updateRecordStats();

        } catch (e) {
            console.error("[Export Error]", e);
            if (!isSingle) showToast("❌ 导出异常", "Excel生成过程中发生错误: " + e.message, COLORS.ERROR);
        }
    }

    // ================= 6. Hook 系统 =================
    function installHooks() {
        const OriginalXHR = realWin.XMLHttpRequest;
        realWin.XMLHttpRequest = class extends OriginalXHR {
            open(method, url) {
                this._url = url;
                return super.open(method, url);
            }
            send(body) {
                this.addEventListener('load', function () {
                    try {
                        if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
                        let data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                        processHookData(this._url, data);
                    } catch (e) { }
                });
                return super.send(body);
            }
        };

        const originalFetch = realWin.fetch;
        realWin.fetch = async (input, init) => {
            const response = await originalFetch(input, init);
            try {
                const url = typeof input === 'string' ? input : input.url;
                const clone = response.clone();
                clone.json().then(data => processHookData(url, data));
            } catch (e) { }
            return response;
        };

        const wrapHistory = (type) => {
            const orig = history[type];
            return function () {
                const rv = orig.apply(this, arguments);
                handleUrlChange();
                return rv;
            };
        };
        history.pushState = wrapHistory('pushState');
        history.replaceState = wrapHistory('replaceState');
        window.addEventListener('popstate', handleUrlChange);

        function handleUrlChange() {
            setTimeout(scanInitialState, 1500);
            updateRecordStats();
            STATE.scrollStableCount = 0;
            STATE.statusText = "待机中";
            STATE.hasAutoCommented = false;
            STATE.interactedNoteId = null;
            STATE.downloadedVideoIds = new Set();
        }

        function processHookData(url, data) {
            tryAutoInteract();
            if (!data) return;
            const settings = getSettings();

            if (url.includes('/api/sns/web/v1/feed')) {
                if (settings.logHooks) {
                    console.log("🔥 [Feed Hook]", data);
                    showToast("🪝 Hook 捕获", "拦截到 Feed 流数据，正在解析...", COLORS.IDLE);
                }
                if (data.data && data.data.items && data.data.items.length > 0) {
                    const note = data.data.items[0].note_card;
                    if (note) {
                        const id = getVal(note, 'noteId', 'id', 'note_id');
                        if (isCurrentUrlMatch(id)) {
                            STATE.currentNoteId = String(id);
                            STATE.hasAutoCommented = false;
                            STATE.interactedNoteId = null;
                            STATE.capturedNote = {
                                title: getVal(note, 'title') || "",
                                desc: getVal(note, 'desc') || "",
                                tags: (getVal(note, 'tagList', 'tag_list') || []).map(t => t.name).join(',')
                            };
                            processNoteData(note);
                            updateBallStatus(COLORS.SUCCESS);
                            tryAutoComment();
                            showToast("🎯 锁定目标", `已定位当前笔记ID: ${id}\n准备执行自动化流程。`, COLORS.SUCCESS);
                        }
                    }
                } else if (data.data && Array.isArray(data.data)) {
                    data.data.forEach(item => {
                        if (item.note_card) processNoteData(item.note_card);
                    });
                }
            }

            if (url.includes('/api/sns/web/v2/comment/page')) {
                if (settings.logHooks) console.log("🔥 [Comment Hook]", data);
                if (data.data && data.data.comments) {
                    const comments = data.data.comments;
                    let nId = STATE.currentNoteId;
                    const urlObj = new URL(url, location.origin);
                    const apiNoteId = urlObj.searchParams.get('note_id');

                    if (apiNoteId && isCurrentUrlMatch(apiNoteId)) {
                        nId = apiNoteId;
                        STATE.currentNoteId = apiNoteId;
                        STATE.capturedComments = comments.slice(0, 15).map(c => c.content);
                        tryAutoComment();
                        showToast("💬 评论获取", `成功捕获 ${comments.length} 条主评论数据。`, COLORS.IDLE);
                    }
                    parseAndRecordComments(nId, comments);
                }
            }

            if (url.includes('/api/sns/web/v2/comment/sub/page')) {
                if (settings.logHooks) console.log("🔥 [Sub-Comment Hook]", data);
                if (data.data && data.data.comments) {
                    const comments = data.data.comments;
                    const urlObj = new URL(url, location.origin);
                    const rootId = urlObj.searchParams.get('root_comment_id');
                    const noteId = urlObj.searchParams.get('note_id');

                    if (noteId && isCurrentUrlMatch(noteId)) {
                        STATE.currentNoteId = noteId;
                        parseAndRecordComments(noteId, comments, rootId);
                        showToast("↳ 子评论获取", `成功捕获 ${comments.length} 条子评论数据。`, COLORS.IDLE);
                    }
                }
            }
        }
    }

    installHooks();

    // ================= 6.5 核心签名引擎捕获 =================
    async function ensureCryptoModule() {
        let attempts = 0;
        const maxAttempts = 50; // 最多轮询 50 次 (约 10 秒)

        const findModule = () => {
            if (realWin._xhs_sign_engine) return true;

            // 1. 尝试直接捕获全局暴露的函数 (部分页面版本)
            if (typeof realWin._webmsxyw === 'function') {
                realWin._xhs_sign_engine = (...args) => realWin._webmsxyw.apply(realWin, args);
                return true;
            }

            // 2. 尝试从 Webpack 中检索
            let containerName = Object.keys(realWin).find(key => key.startsWith('webpackChunk') && key.includes('xhs'));
            if (containerName) {
                try {
                    realWin[containerName].push([["xhs_crypto_extractor_" + Date.now()], {}, function(__webpack_require__) {
                        for (let id in __webpack_require__.m) {
                            try {
                                const mod = __webpack_require__(id);
                                // 深度搜索包含特征字符串的模块
                                if (mod && (typeof mod === 'function' || typeof mod === 'object')) {
                                    const modStr = mod.toString ? mod.toString() : '';
                                    if (modStr.includes('X-s') || modStr.includes('x-s')) {
                                        realWin._xhs_sign_engine = (...args) => mod.apply(realWin, args);
                                        return true;
                                    }
                                }
                            } catch(e){}
                        }
                    }]);
                } catch (e) {}
            }
            return !!realWin._xhs_sign_engine;
        };

        const timer = setInterval(() => {
            attempts++;
            if (findModule() || attempts > maxAttempts) {
                clearInterval(timer);
                if (realWin._xhs_sign_engine) {
                    console.log("[XHS-Bot] 🎯 X-Sign 签名引擎挂载成功");
                } else {
                    console.log("[XHS-Bot] ⚠️ 未能挂载签名引擎，底层评论协议可能失败");
                }
            }
        }, 200);
    }

    ensureCryptoModule();

    // ================= 7. 核心业务逻辑 (AI Streaming & Fixed & 协议动作) =================

    function tryAutoComment() {
        const settings = getSettings();
        if (!settings.enabled || !settings.commentEnabled) return;
        if (STATE.isProcessing || STATE.hasAutoCommented) return;
        if (!STATE.capturedNote && STATE.capturedComments.length === 0) return;

        // [Check] 历史记录检查
        if (checkInHistory(STATE.currentNoteId)) {
            console.log(`[XHS-Bot] ⛔ 笔记 ${STATE.currentNoteId} 在历史记录中，跳过自动评论。`);
            showToast("⛔ 已跳过评论", "检测到该笔记已在历史记录中 (已评论过)。", COLORS.HISTORY);
            STATE.hasAutoCommented = true; // 标记为已完成
            return;
        }

        setTimeout(() => {
            if (STATE.hasAutoCommented) return;
            console.log("🤖 自动触发 AI/固定 评论...");
            STATE.hasAutoCommented = true;
            generateAIContent();
        }, 2000);
    }

    // [Refactored] 支持流式响应/非流式的 AI 生成函数
    async function generateAIContent() {
        if (STATE.isProcessing) return;
        const settings = getSettings();

        if (!settings.enabled) {
            showToast("⏸️ 功能停用", "总开关已关闭，跳过评论生成。", COLORS.ERROR);
            return;
        }

        const randomVal = Math.floor(Math.random() * 100) + 1;
        if (randomVal > settings.commentRate) {
            showToast("🎲 概率未命中", `当前随机值 ${randomVal} 大于设定概率 ${settings.commentRate}%，本次跳过评论。`, COLORS.PROCESSING);
            return;
        }

        STATE.isProcessing = true;
        updateBallStatus(COLORS.PROCESSING);

        // --- 固定语料逻辑 (不变) ---
        if (settings.aiSource === 'fixed') {
            try {
                const lines = settings.fixedComments.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length > 0) {
                    const randomLine = lines[Math.floor(Math.random() * lines.length)];
                    showToast("💬 固定评论", `从 ${lines.length} 条语料中命中:\n"${randomLine}"`, COLORS.SUCCESS);
                    await simulateSendComment(randomLine);
                } else {
                    showToast("⚠️ 无有效语料", "固定评论列表为空，请在设置中添加。", COLORS.ERROR);
                    updateBallStatus(COLORS.ERROR);
                }
            } catch (e) {
                console.error(e);
                showToast("❌ 固定评论异常", e.message, COLORS.ERROR);
            } finally {
                STATE.isProcessing = false;
            }
            return;
        }

        // --- AI 逻辑 ---
        let contextInfo = "";
        if (STATE.capturedNote) {
            contextInfo += `【笔记信息】\n标题: ${STATE.capturedNote.title}\n内容: ${STATE.capturedNote.desc}\n标签: ${STATE.capturedNote.tags}\n\n`;
        }
        if (STATE.capturedComments.length > 0) {
            contextInfo += `【网友热评】\n${STATE.capturedComments.join('\n')}\n\n`;
        }

        const prompt = `${settings.systemPrompt}\n\n${contextInfo}`;
        const useStream = settings.streamEnabled; // 获取开关状态

        showToast("🤖 AI思考中...", `正在请求 ${settings.aiSource === 'online' ? "Online API" : "Local API"} (${useStream ? "流式" : "阻塞"})...`, COLORS.PROCESSING);

        try {
            let fullReply = "";
            const isOnline = settings.aiSource === 'online';
            const apiUrl = isOnline ? settings.onlineUrl : settings.localUrl;
            const headers = { "Content-Type": "application/json" };
            let body = {};

            // 构建请求体，动态设置 stream 参数
            if (isOnline) {
                if (settings.onlineKey) headers["Authorization"] = `Bearer ${settings.onlineKey}`;
                body = {
                    model: settings.onlineModel,
                    messages: [
                        { role: "system", content: settings.systemPrompt },
                        { role: "user", content: contextInfo }
                    ],
                    stream: useStream
                };
            } else {
                body = {
                    model: settings.localModel,
                    prompt: prompt,
                    stream: useStream
                };
            }

            // 【精确修改：打印发送给AI的完整请求体】
            console.log(`\n[XHS-Bot] 📤 准备发送给 AI 的请求 (URL: ${apiUrl}):\n`, JSON.stringify(body, null, 2));

            await new Promise((resolve, reject) => {
                let lastIndex = 0;
                GM_xmlhttpRequest({
                    method: "POST",
                    url: apiUrl,
                    headers: headers,
                    data: JSON.stringify(body),
                    timeout: settings.timeoutSeconds * 1000,
                    responseType: 'text',
                    onreadystatechange: (res) => {
                        // 仅流式模式下处理 onreadystatechange
                        if (!useStream) return;
                        if (res.readyState === 3 || res.readyState === 4) {
                            const newText = res.responseText.substring(lastIndex);
                            lastIndex = res.responseText.length;
                            if (!newText) return;

                            const lines = newText.split('\n');
                            for (const line of lines) {
                                const str = line.trim();
                                if (!str || str === 'data: [DONE]') continue;

                                let jsonStr = str;
                                if (str.startsWith('data: ')) jsonStr = str.substring(6);

                                try {
                                    const json = JSON.parse(jsonStr);
                                    // 兼容 OpenAI (choices[0].delta.content) 和 Ollama (response)
                                    const content = json.choices?.[0]?.delta?.content || json.response || "";
                                    if (content) fullReply += content;
                                } catch (e) { }
                            }
                        }
                    },
                    onload: (res) => {
                        if (res.status === 200) {
                            if (!useStream) {
                                // 非流式模式：直接解析完整 JSON
                                try {
                                    const json = JSON.parse(res.responseText);
                                    // 兼容 OpenAI (choices[0].message.content) 和 Ollama (response)
                                    fullReply = json.choices?.[0]?.message?.content || json.response || "";
                                } catch (e) {
                                    reject("JSON解析失败");
                                    return;
                                }
                            }
                            resolve();
                        } else {
                            reject(`HTTP状态码错误: ${res.status}`);
                        }
                    },
                    onerror: () => reject("网络连接错误"),
                    ontimeout: () => reject("请求超时")
                });
            });

            // 【精确修改：打印AI接口返回的完整原始回复】
            console.log(`\n[XHS-Bot] 📥 AI 接口返回的完整原始回复:\n`, fullReply);

            let finalReply = fullReply.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^["'“]+|["'”]+$/g, '');

            if (finalReply) {
                showToast("💭 生成成功", `AI回复内容:\n"${finalReply}"`, COLORS.SUCCESS);
                await simulateSendComment(finalReply);
            } else {
                throw new Error("API返回了空内容或解析失败");
            }

        } catch (e) {
            showToast("❌ AI生成错误", `详细原因: ${e.toString()}`, COLORS.ERROR);
            updateBallStatus(COLORS.ERROR);
        } finally {
            STATE.isProcessing = false;
        }
    }

    // [New] 基于底层网络协议的评论发送
    async function simulateSendComment(text) {
        showToast("✍️ 正在发送", "正在通过底层接口协议发送评论...", COLORS.PROCESSING);

        if (!realWin._xhs_sign_engine) {
            showToast("❌ 引擎未就绪", "签名引擎未加载，无法发送协议评论，请尝试刷新页面。", COLORS.ERROR);
            return;
        }

        const noteId = STATE.currentNoteId;
        if (!noteId) {
            showToast("❌ 缺少参数", "未获取到当前笔记ID，无法评论。", COLORS.ERROR);
            return;
        }

        const pathStr = "/api/sns/web/v1/comment/post";
        const payload = {
            "note_id": String(noteId),
            "content": text,
            "at_users": []
        };

        try {
            // 1. 利用引擎计算签名
            const signResult = realWin._xhs_sign_engine(pathStr, payload);
            const finalHeaders = signResult.headers ? signResult.headers : signResult;
            const xs = finalHeaders['X-s'] || finalHeaders['x-s'];
            const xt = finalHeaders['X-t'] || finalHeaders['x-t'];

            if (!xs || !xt) {
                throw new Error("X-s 或 X-t 签名生成失败");
            }

            // 2. 构造并发送网络请求 (携带跨域凭证)
            const url = `https://edith.xiaohongshu.com${pathStr}`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json;charset=UTF-8",
                    "x-s": xs,
                    "x-t": xt,
                    "Accept": "application/json, text/plain, */*"
                },
                body: JSON.stringify(payload),
                credentials: "include" // 强制携带 a1, web_session 等 Cookies
            });

            const resData = await response.json();

            if (resData.success || resData.code === 0) {
                showToast("✅ 发送成功", "评论已通过协议成功发布。", COLORS.SUCCESS);
                updateBallStatus(COLORS.SUCCESS);

                // [Record] 发送成功后记录历史
                if (STATE.currentNoteId) {
                    addHistory(STATE.currentNoteId);
                }
            } else {
                throw new Error(resData.msg || resData.message || JSON.stringify(resData));
            }

        } catch (e) {
            console.error("[XHS-Bot] 协议评论发送失败:", e);
            showToast("❌ 发送失败", `接口报错: ${e.message}`, COLORS.ERROR);
            updateBallStatus(COLORS.ERROR);
        }
    }

    // ⚠️ [New] 基于底层网络协议的点赞发送
    async function simulateLikeNote(noteId) {
        if (!realWin._xhs_sign_engine) {
            showToast("❌ 引擎未就绪", "签名引擎未加载，无法发送点赞协议。", COLORS.ERROR);
            return;
        }

        const pathStr = "/api/sns/web/v1/note/like";
        const payload = {
            "note_oid": String(noteId)
        };

        try {
            const signResult = realWin._xhs_sign_engine(pathStr, payload);
            const finalHeaders = signResult.headers ? signResult.headers : signResult;
            const xs = finalHeaders['X-s'] || finalHeaders['x-s'];
            const xt = finalHeaders['X-t'] || finalHeaders['x-t'];

            if (!xs || !xt) {
                throw new Error("X-s 或 X-t 签名生成失败");
            }

            const url = `https://edith.xiaohongshu.com${pathStr}`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json;charset=UTF-8",
                    "x-s": xs,
                    "x-t": xt,
                    "Accept": "application/json, text/plain, */*"
                },
                body: JSON.stringify(payload),
                credentials: "include"
            });

            const resData = await response.json();

            if (resData.success || resData.code === 0) {
                console.log("[XHS-Bot] ✅ 协议点赞成功");
            } else {
                throw new Error(resData.msg || resData.message || JSON.stringify(resData));
            }

        } catch (e) {
            console.error("[XHS-Bot] 协议点赞发送失败:", e);
            showToast("❌ 点赞失败", `接口报错: ${e.message}`, COLORS.ERROR);
        }
    }

    // ⚠️ [New] 基于底层网络协议的收藏发送
    async function simulateCollectNote(noteId) {
        if (!realWin._xhs_sign_engine) {
            showToast("❌ 引擎未就绪", "签名引擎未加载，无法发送收藏协议。", COLORS.ERROR);
            return;
        }

        const pathStr = "/api/sns/web/v1/note/collect";
        const payload = {
            "note_id": String(noteId)
        };

        try {
            const signResult = realWin._xhs_sign_engine(pathStr, payload);
            const finalHeaders = signResult.headers ? signResult.headers : signResult;
            const xs = finalHeaders['X-s'] || finalHeaders['x-s'];
            const xt = finalHeaders['X-t'] || finalHeaders['x-t'];

            if (!xs || !xt) {
                throw new Error("X-s 或 X-t 签名生成失败");
            }

            const url = `https://edith.xiaohongshu.com${pathStr}`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json;charset=UTF-8",
                    "x-s": xs,
                    "x-t": xt,
                    "Accept": "application/json, text/plain, */*"
                },
                body: JSON.stringify(payload),
                credentials: "include"
            });

            const resData = await response.json();

            if (resData.success || resData.code === 0) {
                console.log("[XHS-Bot] ✅ 协议收藏成功");
            } else {
                throw new Error(resData.msg || resData.message || JSON.stringify(resData));
            }

        } catch (e) {
            console.error("[XHS-Bot] 协议收藏发送失败:", e);
            showToast("❌ 收藏失败", `接口报错: ${e.message}`, COLORS.ERROR);
        }
    }

    // ================= 8. UI 构建 =================

    function repositionPanel(btn, panel) {
        const rect = btn.getBoundingClientRect();
        const pW = 340;
        let left = rect.left - pW - 10;
        let top = rect.top;
        if (left < 10) left = rect.right + 10;
        if (top + panel.offsetHeight > window.innerHeight) top = window.innerHeight - panel.offsetHeight - 10;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    GM_addStyle(`
        :root {
            --xhs-bg: rgba(255, 255, 255, 0.98);
            --xhs-text: #2d3436;
            --xhs-border: #dfe6e9;
            --xhs-accent: #0984e3;
            --dy-box-bg: rgba(9, 132, 227, 0.05);
            --off-color: #b2bec3;
        }
        .xhs-dark-mode {
            --xhs-bg: rgba(45, 52, 54, 0.98);
            --xhs-text: #dfe6e9;
            --xhs-border: #636e72;
            --xhs-accent: #74b9ff;
            --dy-box-bg: rgba(116, 185, 255, 0.05);
            --off-color: #636e72;
        }
        #xhs-helper-btn { position: fixed; z-index: 999999; width: 50px; height: 50px; background: ${COLORS.IDLE}; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: move; box-shadow: 0 5px 15px rgba(0,0,0,0.2); font-size: 24px; user-select: none; }

        #xhs-panel {
            position: fixed;
            width: 340px;
            background: var(--xhs-bg);
            color: var(--xhs-text);
            padding: 0;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            display: none;
            flex-direction: column;
            z-index: 999998;
            border: 1px solid var(--xhs-border);
            max-height: 80vh;
            overflow: hidden;
        }

        .xhs-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 20px 10px 20px;
            border-bottom: 1px solid var(--xhs-border);
            flex-shrink: 0;
            background: var(--xhs-bg);
            z-index: 2;
            border-radius: 12px 12px 0 0;
        }

        .xhs-panel-body {
            flex: 1;
            overflow-y: auto;
            padding: 10px 20px 20px 20px;
            min-height: 0;
        }

        #xhs-close {
            cursor: pointer;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            transition: all 0.2s;
            font-size: 16px;
            color: var(--off-color);
            user-select: none;
        }
        #xhs-close:hover {
            background-color: #ff7675;
            color: white;
            transform: rotate(90deg);
        }

        .xhs-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .xhs-switch { position: relative; width: 40px; height: 20px; }
        .xhs-switch input { opacity: 0; width: 0; height: 0; }
        .xhs-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--off-color); transition: .4s; border-radius: 20px; }
        .xhs-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }

        input:checked + .xhs-slider { background-color: var(--xhs-accent); }
        #cfg-recordingEnabled:checked + .xhs-slider { background-color: #ff7675; }
        #cfg-motrixEnabled:checked + .xhs-slider { background-color: #6c5ce7; }
        #cfg-interactEnabled:checked + .xhs-slider { background-color: #e17055; }
        #cfg-streamEnabled:checked + .xhs-slider { background-color: #00cec9; }

        input:checked + .xhs-slider:before { transform: translateX(20px); }

        .xhs-input { width: 100%; padding: 8px; margin-top: 5px; border: 1px solid var(--xhs-border); border-radius: 6px; background: transparent; color: var(--xhs-text); }
        .dy-config-box { background: var(--dy-box-bg); padding: 10px; border-radius: 8px; margin-bottom: 10px; border: 1px dashed var(--xhs-accent); }
        .xhs-btn { width: 100%; padding: 10px; margin-top: 5px; border: none; border-radius: 6px; cursor: pointer; color: white; font-weight: bold; background: var(--xhs-accent); }
        .xhs-btn:hover { opacity: 0.9; }

        .xhs-range-input {
            -webkit-appearance: none;
            width: 100%;
            height: 6px;
            background: #dfe6e9;
            border-radius: 5px;
            outline: none;
            cursor: pointer;
            margin-top: 5px;
        }
        .xhs-range-input::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--xhs-accent);
            cursor: pointer;
            transition: transform 0.1s;
            margin-top: 0px;
        }
        .xhs-range-input::-webkit-slider-thumb:hover { transform: scale(1.1); }
        .xhs-dark-mode .xhs-range-input { background: #636e72; }

        #xhs-toast {
            position: fixed;
            top: 60px;
            right: 20px;
            z-index: 100000;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            pointer-events: none;
        }
        .xhs-toast-msg {
            pointer-events: auto;
            width: 320px;
            height: auto;
            min-height: 50px;
            background: var(--xhs-bg);
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 12px;
            border-left: 5px solid;
            box-shadow: 0 4px 15px rgba(0,0,0,0.15);
            color: var(--xhs-text);
            font-size: 13px;
            line-height: 1.5;
            word-wrap: break-word;
            word-break: break-all;
            white-space: pre-wrap;
            box-sizing: border-box;
            opacity: 0;
            animation: xhs-slide-in 0.35s cubic-bezier(0.21, 1.02, 0.73, 1) forwards;
        }
        @keyframes xhs-slide-in {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }

        .xhs-tab-container { display: flex; margin-bottom: 10px; background: var(--xhs-border); padding: 2px; border-radius: 6px; }
        .xhs-tab-btn { flex: 1; padding: 6px; border: none; background: transparent; color: var(--xhs-text); cursor: pointer; }
        .xhs-tab-btn.active { background: var(--xhs-bg); color: var(--xhs-accent); border-radius: 4px; }
    `);

    function createUI() {
        if (document.getElementById('xhs-helper-btn')) return;

        const btn = document.createElement('div');
        btn.id = 'xhs-helper-btn';
        btn.innerHTML = '🤖';
        const savedTop = GM_getValue('xhs_btn_top', '80%');
        const savedLeft = GM_getValue('xhs_btn_left', '90%');
        btn.style.top = savedTop;
        btn.style.left = savedLeft;

        let isDragging = false, startT = 0, raf = null;
        btn.onmousedown = (e) => {
            isDragging = false; startT = Date.now();
            let shiftX = e.clientX - btn.getBoundingClientRect().left;
            let shiftY = e.clientY - btn.getBoundingClientRect().top;
            const move = (cx, cy) => {
                isDragging = true;
                if (raf) cancelAnimationFrame(raf);
                raf = requestAnimationFrame(() => {
                    btn.style.left = (cx - shiftX) + 'px';
                    btn.style.top = (cy - shiftY) + 'px';
                    const p = document.getElementById('xhs-panel');
                    if (p && p.style.display !== 'none') repositionPanel(btn, p);
                });
            };
            const onMove = (evt) => move(evt.clientX, evt.clientY);
            document.addEventListener('mousemove', onMove);
            document.onmouseup = () => {
                document.removeEventListener('mousemove', onMove);
                document.onmouseup = null;
                if (isDragging) {
                    GM_setValue('xhs_btn_top', btn.style.top);
                    GM_setValue('xhs_btn_left', btn.style.left);
                }
            };
        };

        const panel = document.createElement('div');
        panel.id = 'xhs-panel';
        const s = getSettings();
        if (s.darkMode) panel.classList.add('xhs-dark-mode');

        panel.innerHTML = `
            <div class="xhs-panel-header">
                <h3 style="margin:0">小红书助手 v15.29</h3>
                <span id="xhs-close" title="关闭">✕</span>
            </div>

            <div class="xhs-panel-body">
                <div class="xhs-row"><span>🔌 总开关</span><label class="xhs-switch"><input type="checkbox" id="cfg-enabled"><span class="xhs-slider"></span></label></div>
                <div class="xhs-row"><span>🌙 暗黑模式</span><label class="xhs-switch"><input type="checkbox" id="cfg-darkMode"><span class="xhs-slider"></span></label></div>
                <div class="xhs-row"><span>🪝 Hook日志</span><label class="xhs-switch"><input type="checkbox" id="cfg-logHooks"><span class="xhs-slider"></span></label></div>

                <div class="dy-config-box" style="border-color:#e17055">
                    <div class="xhs-row">
                        <span style="color:#e17055;font-weight:bold">👍 自动点赞收藏</span>
                        <label class="xhs-switch"><input type="checkbox" id="cfg-interactEnabled"><span class="xhs-slider"></span></label>
                    </div>
                    <div id="box-interact" style="display:${s.interactEnabled ? 'block' : 'none'}">
                        <div style="margin:5px 0;font-size:12px">点赞概率: <span id="val-like-rate">${s.likeRate}</span>%</div>
                        <input type="range" id="cfg-likeRate" class="xhs-range-input" min="0" max="100" value="${s.likeRate}">
                        <div style="margin:5px 0;font-size:12px">收藏概率: <span id="val-collect-rate">${s.collectRate}</span>%</div>
                        <input type="range" id="cfg-collectRate" class="xhs-range-input" min="0" max="100" value="${s.collectRate}">
                    </div>
                </div>

                <div class="dy-config-box">
                    <div class="xhs-row">
                        <span style="color:var(--xhs-accent);font-weight:bold">💬 启用评论</span>
                        <label class="xhs-switch"><input type="checkbox" id="cfg-commentEnabled"><span class="xhs-slider"></span></label>
                    </div>
                    <div id="box-comment" style="display:${s.commentEnabled ? 'block' : 'none'}">
                        <div style="margin:5px 0;font-size:12px">触发概率: <span id="val-rate">${s.commentRate}</span>%</div>
                        <input type="range" id="cfg-rate" class="xhs-range-input" min="0" max="100" value="${s.commentRate}">

                        <div class="xhs-tab-container" style="margin-top:10px">
                            <button class="xhs-tab-btn ${s.aiSource === 'local' ? 'active' : ''}" id="tab-local">本地</button>
                            <button class="xhs-tab-btn ${s.aiSource === 'online' ? 'active' : ''}" id="tab-online">在线</button>
                            <button class="xhs-tab-btn ${s.aiSource === 'fixed' ? 'active' : ''}" id="tab-fixed">固定</button>
                        </div>

                        <div class="xhs-row" style="margin: 8px 0;">
                            <span style="font-size:12px">🌊 流式输出 (打字机效果)</span>
                            <label class="xhs-switch"><input type="checkbox" id="cfg-streamEnabled"><span class="xhs-slider"></span></label>
                        </div>

                        <div id="view-local" style="display:${s.aiSource === 'local' ? 'block' : 'none'}">
                            <input class="xhs-input" id="cfg-localUrl" value="${s.localUrl}" placeholder="API Url">
                            <input class="xhs-input" id="cfg-localModel" value="${s.localModel}" placeholder="Model Name">
                        </div>
                        <div id="view-online" style="display:${s.aiSource === 'online' ? 'block' : 'none'}">
                            <input class="xhs-input" id="cfg-onlineUrl" value="${s.onlineUrl}" placeholder="API Url">
                            <input class="xhs-input" id="cfg-onlineModel" value="${s.onlineModel}" placeholder="Model Name">
                            <input class="xhs-input" id="cfg-onlineKey" type="password" value="${s.onlineKey}" placeholder="API Key">
                        </div>
                         <div id="view-fixed" style="display:${s.aiSource === 'fixed' ? 'block' : 'none'}">
                            <textarea class="xhs-input" id="cfg-fixedComments" style="height:120px;resize:vertical" placeholder="输入固定评论，每行一条">${s.fixedComments}</textarea>
                        </div>
                        <div id="view-prompt" style="display:${s.aiSource === 'fixed' ? 'none' : 'block'}">
                             <textarea class="xhs-input" id="cfg-prompt" style="height:60px;resize:vertical" placeholder="提示词">${s.systemPrompt}</textarea>
                        </div>
                    </div>
                </div>

                <div class="dy-config-box" style="border-color:#ff7675">
                    <div class="xhs-row">
                        <span style="color:#ff7675;font-weight:bold">📼 数据录制与导出</span>
                        <label class="xhs-switch"><input type="checkbox" id="cfg-recordingEnabled"><span class="xhs-slider"></span></label>
                    </div>
                    <div id="box-record" style="display:${s.recordingEnabled ? 'block' : 'none'}">
                        <div class="xhs-row">
                            <span style="font-size:12px">🔄 自动导出单篇(静默后)</span>
                            <label class="xhs-switch"><input type="checkbox" id="cfg-autoExport"><span class="xhs-slider"></span></label>
                        </div>
                        <div class="xhs-row">
                            <span style="font-size:12px">⏬ 自动下滑加载全部主评论</span>
                            <label class="xhs-switch"><input type="checkbox" id="cfg-scrollMain"><span class="xhs-slider"></span></label>
                        </div>
                        <div class="xhs-row">
                            <span style="font-size:12px">📂 自动展开并抓取子评论</span>
                            <label class="xhs-switch"><input type="checkbox" id="cfg-autoExpand"><span class="xhs-slider"></span></label>
                        </div>
                        <div class="xhs-row">
                            <span style="font-size:12px">⬇️ 自动下载视频</span>
                            <label class="xhs-switch"><input type="checkbox" id="cfg-autoDlVideo"><span class="xhs-slider"></span></label>
                        </div>
                        <div style="font-size:12px;margin-bottom:5px">
                            内存池总数: <span id="val-recorded-note-count" style="font-weight:bold">${realWin.dy_record_map.size}</span> 篇 (最多200)<br>
                            当前评论数: <span id="val-recorded-count" style="font-weight:bold">0</span><br>
                            状态: <span id="val-status-text" style="color:var(--xhs-accent)">待机中</span>
                        </div>
                    </div>
                </div>

                <div class="dy-config-box" style="border-color:#6c5ce7">
                    <div class="xhs-row">
                        <span style="color:#6c5ce7;font-weight:bold">📡 Motrix 配置</span>
                        <label class="xhs-switch"><input type="checkbox" id="cfg-motrixEnabled"><span class="xhs-slider"></span></label>
                    </div>
                    <div id="box-motrix" style="display:${s.motrixEnabled ? 'block' : 'none'}">
                        <div style="font-size:12px;color:#999;margin-bottom:5px">开启后 Excel 导出将提示不支持并降级为浏览器下载</div>
                        <input class="xhs-input" id="cfg-motrixUrl" value="${s.motrixUrl}" placeholder="RPC地址: http://127.0.0.1:16800/jsonrpc">
                        <input class="xhs-input" id="cfg-motrixKey" type="password" value="${s.motrixKey}" placeholder="RPC密钥 (选填)">
                    </div>
                </div>
            </div>

            <div style="padding:15px 20px;border-top:1px solid var(--xhs-border);background:var(--xhs-bg);flex-shrink:0;border-radius:0 0 12px 12px;">
                <button class="xhs-btn" id="xhs-save">💾 保存配置</button>
            </div>
        `;

        const toast = document.createElement('div');
        toast.id = 'xhs-toast';
        if (s.darkMode) toast.classList.add('xhs-dark-mode');
        document.body.append(btn, panel, toast);

        btn.onclick = (e) => {
            if (isDragging || (Date.now() - startT > 200)) return;
            panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
            if (panel.style.display === 'flex') repositionPanel(btn, panel);
        };
        btn.oncontextmenu = (e) => {
            e.preventDefault();
            generateAIContent();
        };

        document.getElementById('xhs-close').onclick = () => panel.style.display = 'none';

        const bindToggle = (id, boxId) => {
            document.getElementById(id).onchange = (e) => {
                if (boxId) document.getElementById(boxId).style.display = e.target.checked ? 'block' : 'none';
            };
        };
        bindToggle('cfg-commentEnabled', 'box-comment');
        bindToggle('cfg-recordingEnabled', 'box-record');
        bindToggle('cfg-motrixEnabled', 'box-motrix');
        bindToggle('cfg-interactEnabled', 'box-interact');

        const tLocal = document.getElementById('tab-local');
        const tOnline = document.getElementById('tab-online');
        const tFixed = document.getElementById('tab-fixed');
        const vPrompt = document.getElementById('view-prompt');

        const switchTab = (mode) => {
            tLocal.className = mode === 'local' ? 'xhs-tab-btn active' : 'xhs-tab-btn';
            tOnline.className = mode === 'online' ? 'xhs-tab-btn active' : 'xhs-tab-btn';
            tFixed.className = mode === 'fixed' ? 'xhs-tab-btn active' : 'xhs-tab-btn';

            document.getElementById('view-local').style.display = mode === 'local' ? 'block' : 'none';
            document.getElementById('view-online').style.display = mode === 'online' ? 'block' : 'none';
            document.getElementById('view-fixed').style.display = mode === 'fixed' ? 'block' : 'none';
            vPrompt.style.display = mode === 'fixed' ? 'none' : 'block';
        };

        tLocal.onclick = () => switchTab('local');
        tOnline.onclick = () => switchTab('online');
        tFixed.onclick = () => switchTab('fixed');

        const updateSliderVisual = (id, valDisplayId, val) => {
            const input = document.getElementById(id);
            const percent = val + '%';
            const color = id === 'cfg-likeRate' || id === 'cfg-collectRate' ? '#e17055' : 'var(--xhs-accent)';
            input.style.background = `linear-gradient(to right, ${color} ${percent}, #dfe6e9 ${percent})`;
            document.getElementById(valDisplayId).innerText = val;
        };

        updateSliderVisual('cfg-rate', 'val-rate', s.commentRate);
        updateSliderVisual('cfg-likeRate', 'val-like-rate', s.likeRate);
        updateSliderVisual('cfg-collectRate', 'val-collect-rate', s.collectRate);

        document.getElementById('cfg-rate').oninput = (e) => updateSliderVisual('cfg-rate', 'val-rate', e.target.value);
        document.getElementById('cfg-likeRate').oninput = (e) => updateSliderVisual('cfg-likeRate', 'val-like-rate', e.target.value);
        document.getElementById('cfg-collectRate').oninput = (e) => updateSliderVisual('cfg-collectRate', 'val-collect-rate', e.target.value);

        const setC = (id, v) => document.getElementById(id).checked = v;
        setC('cfg-enabled', s.enabled);
        setC('cfg-darkMode', s.darkMode);
        setC('cfg-logHooks', s.logHooks);
        setC('cfg-commentEnabled', s.commentEnabled);
        setC('cfg-recordingEnabled', s.recordingEnabled);
        setC('cfg-autoExport', s.autoExport);
        setC('cfg-scrollMain', s.scrollMain);
        setC('cfg-autoExpand', s.autoExpand);
        setC('cfg-autoDlVideo', s.autoDlVideo);
        setC('cfg-motrixEnabled', s.motrixEnabled);
        setC('cfg-interactEnabled', s.interactEnabled);
        setC('cfg-streamEnabled', s.streamEnabled);

        document.getElementById('cfg-darkMode').addEventListener('change', (e) => {
            const isDark = e.target.checked;
            const p = document.getElementById('xhs-panel');
            const t = document.getElementById('xhs-toast');
            if (isDark) {
                p.classList.add('xhs-dark-mode');
                t.classList.add('xhs-dark-mode');
            } else {
                p.classList.remove('xhs-dark-mode');
                t.classList.remove('xhs-dark-mode');
            }
            setTimeout(() => {
                updateSliderVisual('cfg-rate', 'val-rate', document.getElementById('cfg-rate').value);
                updateSliderVisual('cfg-likeRate', 'val-like-rate', document.getElementById('cfg-likeRate').value);
                updateSliderVisual('cfg-collectRate', 'val-collect-rate', document.getElementById('cfg-collectRate').value);
            }, 50);
        });

        document.getElementById('xhs-save').onclick = () => {
            const getC = (id) => document.getElementById(id).checked;
            const getV = (id) => document.getElementById(id).value;

            let currentAiSource = 'local';
            if (document.getElementById('view-online').style.display === 'block') currentAiSource = 'online';
            if (document.getElementById('view-fixed').style.display === 'block') currentAiSource = 'fixed';

            const newS = {
                enabled: getC('cfg-enabled'),
                darkMode: getC('cfg-darkMode'),
                logHooks: getC('cfg-logHooks'),

                interactEnabled: getC('cfg-interactEnabled'),
                likeRate: parseInt(getV('cfg-likeRate')),
                collectRate: parseInt(getV('cfg-collectRate')),

                commentEnabled: getC('cfg-commentEnabled'),
                commentRate: parseInt(getV('cfg-rate')),
                streamEnabled: getC('cfg-streamEnabled'),

                recordingEnabled: getC('cfg-recordingEnabled'),
                autoExport: getC('cfg-autoExport'),
                scrollMain: getC('cfg-scrollMain'),
                autoExpand: getC('cfg-autoExpand'),
                autoDlVideo: getC('cfg-autoDlVideo'),

                motrixEnabled: getC('cfg-motrixEnabled'),
                motrixUrl: getV('cfg-motrixUrl'),
                motrixKey: getV('cfg-motrixKey'),

                aiSource: currentAiSource,
                fixedComments: getV('cfg-fixedComments'),

                localUrl: getV('cfg-localUrl'),
                localModel: getV('cfg-localModel'),
                onlineUrl: getV('cfg-onlineUrl'),
                onlineModel: getV('cfg-onlineModel'),
                onlineKey: getV('cfg-onlineKey'),
                systemPrompt: getV('cfg-prompt')
            };
            saveSettings(newS);
            panel.style.display = 'none';
            const t = document.getElementById('xhs-toast');
            if (newS.darkMode) {
                panel.classList.add('xhs-dark-mode');
                t.classList.add('xhs-dark-mode');
            } else {
                panel.classList.remove('xhs-dark-mode');
                t.classList.remove('xhs-dark-mode');
            }

            updateSliderVisual('cfg-rate', 'val-rate', newS.commentRate);
            updateSliderVisual('cfg-likeRate', 'val-like-rate', newS.likeRate);
            updateSliderVisual('cfg-collectRate', 'val-collect-rate', newS.collectRate);
        };

        setTimeout(scanInitialState, 1500);
        updateRecordStats();
    }

    function updateBallStatus(color) {
        const btn = document.getElementById('xhs-helper-btn');
        if (btn) btn.style.background = color;
    }

    function showToast(title, msg, color) {
        const c = document.getElementById('xhs-toast');
        if (!c) return;
        const d = document.createElement('div');
        d.className = 'xhs-toast-msg';
        d.style.borderLeftColor = color;
        const safeMsg = String(msg).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
        d.innerHTML = `<b style="display:block;margin-bottom:4px;font-size:14px;">${title}</b>${safeMsg}`;
        c.appendChild(d);
        setTimeout(() => {
            d.style.opacity = '0';
            d.style.transform = 'translateX(100%)';
            setTimeout(() => d.remove(), 300);
        }, 5000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }

})();

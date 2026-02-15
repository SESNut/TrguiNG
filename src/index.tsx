import "css/loader.css";
import { Config, ConfigContext } from "./config";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import React, { lazy, Suspense, useContext } from "react";
import type { CSSProperties } from "react";

// Ensure 'listen' is imported for global events
const { TAURI, appWindow, invoke, listen } = await import(/* webpackChunkName: "taurishim" */"taurishim");

const TauriApp = lazy(async () => await import("components/app"));
const WebApp = lazy(async () => await import("components/webapp"));
const CustomMantineProvider = lazy(
    async () => await import("components/mantinetheme"));

async function onCloseRequested(app: Root, config: Config) {
    await config.save();
    await appWindow.emit("listener-pause", {});
    app.unmount();
    const configs = config.getOpenServers().map((serverConfig) => ({
        name: serverConfig.name,
        connection: serverConfig.connection,
        interval: serverConfig.intervals.torrentsMinimized,
    }));
    await invoke("set_poller_config", {
        configs, toast: config.values.app.toastNotifications, sound: config.values.app.toastNotificationSound,
    });
    void appWindow.emit("frontend-done");
}

async function onFocusChange(focused: boolean, config: Config) {
    if (!focused && config.values.app.onMinimize === "hide") {
        if (await appWindow.isMinimized()) {
            void appWindow.emit("window-hidden");
            void appWindow.hide();
        }
    }
}

function setupTauriEvents(config: Config, app: Root) {
    // GLOBAL LISTENER: Catches the signal from the Rust AppHandle
    void listen("close-after-external-add", () => {
        setTimeout(async () => {
            const behavior = config.values.app.onClose;
            if (behavior === "hide") {
                void appWindow.emit("window-hidden");
                void appWindow.hide();
            } else if (behavior === "quit") {
                config.save().finally(() => {
                    void appWindow.emit("app-exit");
                });
            } else {
                void onCloseRequested(app, config);
            }
        }, 1500);
    });

    void appWindow.onCloseRequested((event) => {
        if (config.values.app.onClose === "hide") {
            event.preventDefault();
            void appWindow.emit("window-hidden");
            void appWindow.hide();
        } else if (config.values.app.onClose === "quit") {
            event.preventDefault();
            config.save().finally(() => {
                void appWindow.emit("app-exit");
            });
        } else {
            void onCloseRequested(app, config);
        }
    });

    void appWindow.listen("exit-requested", () => {
        void onCloseRequested(app, config);
    });

    void appWindow.onFocusChanged(({ payload: focused }) => {
        void onFocusChange(focused, config);
    });

    void appWindow.onResized(({ payload: size }) => {
        if (size.width > 0 && size.height > 0) {
            config.values.app.window.size = [size.width, size.height];
        }
    });

    void appWindow.onMoved(({ payload: size }) => {
        if (size.x > -32000 && size.y > -32000) {
            config.values.app.window.position = [size.x, size.y];
        }
    });
}

function setupWebEvents(config: Config) {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            config.save().catch(() => { });
        }
    });
}

async function restoreWindow(config: Config) {
    const positionWindow = async function () {
        const pos = config.values.app.window.position;
        if (pos?.length === 2 && pos?.[0] > -32000 && pos?.[1] > -32000) {
            await appWindow.setPosition(pos);
        } else {
            await appWindow.center();
        }
    };

    const sizeCheck = async function () {
        const sz = await appWindow.getSize();
        const delta = [sz.width - size[0], sz.height - size[1]];
        if (delta[0] != 0 || delta[1] != 0) {
            await appWindow.setSize([size[0] - delta[0], size[1] - delta[1]]);
        }
    };

    const size = config.values.app.window.size;
    if (size.length === 2 && size[0] > 100 && size[1] > 100) {
        await appWindow.setSize(size);
        setTimeout(sizeCheck, 20);
    }
    void positionWindow();
}

function Loader() {
    const config = useContext(ConfigContext);
    const theme = config.values.interface.theme;
    return (
        <div className="loader-container" style={{ backgroundColor: theme === "dark" ? "#1A1B1E" : "#fff" }}>
            <div className="lds-ring"><div></div><div></div><div></div><div></div></div>
        </div>
    );
}

async function run(config: Config) {
    const appnode = document.getElementById("app") as HTMLElement;
    const app = createRoot(appnode);
    if (TAURI) {
        setupTauriEvents(config, app);
        if (config.values.app.showTrayIcon) void invoke("create_tray");
        await restoreWindow(config);
    } else {
        setupWebEvents(config);
    }
    app.render(
        <React.StrictMode>
            <ConfigContext.Provider value={config}>
                <Suspense fallback={<Loader />}>
                    <CustomMantineProvider>
                        {TAURI ? <TauriApp /> : <WebApp />}
                    </CustomMantineProvider>
                </Suspense>
            </ConfigContext.Provider>
        </React.StrictMode>
    );
}

window.onload = () => {
    new Config().read().then(run).catch(console.error);
};

/**
 * TrguiNG - next gen remote GUI for transmission torrent daemon
 * Copyright (C) 2023  qu1ck (mail at qu1ck.org)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import "css/loader.css";
import { Config, ConfigContext } from "./config";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import React, { lazy, Suspense, useContext } from "react";
import type { CSSProperties } from "react";
const { TAURI, appWindow, invoke } = await import(/* webpackChunkName: "taurishim" */"taurishim");

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
    // --- AUTO-CLOSE ON EXTERNAL ADD ---
    // Wrapped in void to prevent blocking the app startup
    void appWindow.listen("close-after-external-add", () => {
        setTimeout(async () => {
            if (config.values.app.onClose === "hide") {
                void appWindow.emit("window-hidden");
                void appWindow.hide();
            } else if (config.values.app.onClose === "quit") {
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

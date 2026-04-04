import { n as __esmMin, t as __commonJSMin } from "./assets/chunk-C9LnQP83.js";
import "./assets/modulepreload-polyfill-aOyzcF2x.js";
import { n as require_client, r as require_react, t as require_jsx_runtime } from "./assets/jsx-runtime-ygBq2LhR.js";
import { n as init_types, t as MSG } from "./assets/types-XsW6vnjp.js";
//#region src/popup/Popup.tsx
function Popup() {
	const [authed, setAuthed] = (0, import_react$1.useState)(null);
	const [state, setState] = (0, import_react$1.useState)({
		status: "idle",
		id: null,
		tabId: null,
		startTime: null
	});
	const [elapsed, setElapsed] = (0, import_react$1.useState)("00:00");
	const [error, setError] = (0, import_react$1.useState)("");
	const [loading, setLoading] = (0, import_react$1.useState)(false);
	const [mode, setMode] = (0, import_react$1.useState)("window");
	const [micEnabled, setMicEnabled] = (0, import_react$1.useState)(false);
	const [savedLink, setSavedLink] = (0, import_react$1.useState)(null);
	const [copied, setCopied] = (0, import_react$1.useState)(false);
	const [theme, setTheme] = (0, import_react$1.useState)(() => {
		return localStorage.getItem("devrecorder-theme") || "dark";
	});
	const timerRef = (0, import_react$1.useRef)(null);
	const startTimeRef = (0, import_react$1.useRef)(null);
	(0, import_react$1.useEffect)(() => {
		document.documentElement.setAttribute("data-theme", theme);
		localStorage.setItem("devrecorder-theme", theme);
	}, [theme]);
	const toggleTheme = () => setTheme((t) => t === "dark" ? "light" : "dark");
	(0, import_react$1.useEffect)(() => {
		chrome.storage.local.get("apiToken").then(({ apiToken }) => {
			setAuthed(!!apiToken);
		});
		const listener = (changes, area) => {
			if (area === "local" && changes.apiToken) setAuthed(!!changes.apiToken.newValue);
		};
		chrome.storage.onChanged.addListener(listener);
		return () => chrome.storage.onChanged.removeListener(listener);
	}, []);
	(0, import_react$1.useEffect)(() => {
		if (!authed) return;
		chrome.runtime.sendMessage({ type: MSG.RECORDING_STATE }).then((res) => {
			if (res) {
				setState(res);
				if (res.status === "recording" && res.startTime) {
					startTimeRef.current = res.startTime;
					startTimer();
				}
			}
		});
		navigator.permissions.query({ name: "microphone" }).then((p) => {
			setMicEnabled(p.state === "granted");
		}).catch(() => {});
		return () => stopTimer();
	}, [authed]);
	const startTimer = (0, import_react$1.useCallback)(() => {
		stopTimer();
		timerRef.current = setInterval(() => {
			if (!startTimeRef.current) return;
			const sec = Math.floor((Date.now() - startTimeRef.current) / 1e3);
			setElapsed(`${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`);
		}, 1e3);
	}, []);
	const stopTimer = () => {
		if (timerRef.current) clearInterval(timerRef.current);
		timerRef.current = null;
	};
	const handleSignIn = () => {
		chrome.tabs.create({ url: `${FRONTEND_URL}/extension-auth` });
		window.close();
	};
	const handleSignOut = () => {
		chrome.storage.local.remove("apiToken");
		setAuthed(false);
	};
	const handleRecord = async () => {
		setError("");
		setLoading(true);
		setSavedLink(null);
		try {
			if (state.status === "idle") {
				const [tab] = await chrome.tabs.query({
					active: true,
					currentWindow: true
				});
				if (!tab?.id) {
					setError("No active tab found");
					setLoading(false);
					return;
				}
				const result = await chrome.runtime.sendMessage({
					type: MSG.START_RECORDING,
					tabId: tab.id,
					tabTitle: tab.title || "",
					tabUrl: tab.url || "",
					captureMode: mode
				});
				if (result.success) {
					startTimeRef.current = Date.now();
					setState({
						status: "recording",
						id: result.recordingId,
						tabId: tab.id,
						startTime: Date.now()
					});
					startTimer();
				} else setError(result.error || "Failed to start");
			} else if (state.status === "recording") {
				const recId = state.id;
				const result = await chrome.runtime.sendMessage({ type: MSG.STOP_RECORDING });
				if (result.success) {
					setState({
						status: "idle",
						id: null,
						tabId: null,
						startTime: null
					});
					stopTimer();
					setElapsed("00:00");
					if (recId) setSavedLink(`${FRONTEND_URL}/recordings/${recId}`);
				} else setError(result.error || "Failed to stop");
			}
		} catch (err) {
			setError(err.message);
		}
		setLoading(false);
	};
	const handleCopy = () => {
		if (!savedLink) return;
		navigator.clipboard.writeText(savedLink).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2e3);
		});
	};
	const handleOpen = () => {
		if (!savedLink) return;
		chrome.tabs.create({ url: savedLink });
		window.close();
	};
	if (authed === null) return /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
		className: "container",
		children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
			className: "header",
			children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
				className: "logo",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
					className: "logo-icon",
					children: "⬤"
				}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
					className: "logo-text",
					children: "DevRecorder"
				})]
			})
		})
	});
	if (!authed) return /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
		className: "container",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
				className: "header",
				children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
					className: "logo",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
						className: "logo-icon",
						children: "⬤"
					}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
						className: "logo-text",
						children: "DevRecorder"
					})]
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
				className: "login-section",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
						className: "login-icon",
						children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
							width: "40",
							height: "40",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.5",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" }),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("polyline", { points: "10 17 15 12 10 7" }),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "15",
									y1: "12",
									x2: "3",
									y2: "12"
								})
							]
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("h2", {
						className: "login-title",
						children: "Sign in to record"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("p", {
						className: "login-subtitle",
						children: "Connect your DevRecorder account to start capturing debug sessions."
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("button", {
						className: "btn-login",
						onClick: handleSignIn,
						children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", {
									d: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z",
									fill: "#4285F4"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", {
									d: "M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z",
									fill: "#34A853"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", {
									d: "M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z",
									fill: "#FBBC05"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", {
									d: "M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z",
									fill: "#EA4335"
								})
							]
						}), "Continue with Google"]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
				className: "footer",
				children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("button", {
					className: "theme-toggle",
					onClick: toggleTheme,
					title: `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
					children: theme === "dark" ? /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
						width: "16",
						height: "16",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("circle", {
								cx: "12",
								cy: "12",
								r: "5"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "12",
								y1: "1",
								x2: "12",
								y2: "3"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "12",
								y1: "21",
								x2: "12",
								y2: "23"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "4.22",
								y1: "4.22",
								x2: "5.64",
								y2: "5.64"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "18.36",
								y1: "18.36",
								x2: "19.78",
								y2: "19.78"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "1",
								y1: "12",
								x2: "3",
								y2: "12"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "21",
								y1: "12",
								x2: "23",
								y2: "12"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "4.22",
								y1: "19.78",
								x2: "5.64",
								y2: "18.36"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "18.36",
								y1: "5.64",
								x2: "19.78",
								y2: "4.22"
							})
						]
					}) : /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("svg", {
						width: "16",
						height: "16",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" })
					})
				})
			})
		]
	});
	const isRecording = state.status === "recording";
	if (savedLink) return /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
		className: "container",
		children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
			className: "saved-modal",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
					className: "saved-icon",
					children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
						width: "32",
						height: "32",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "#22c55e",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("polyline", { points: "22 4 12 14.01 9 11.01" })]
					})
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("h2", {
					className: "saved-title",
					children: "Recording Saved"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("p", {
					className: "saved-subtitle",
					children: "Your recording is being uploaded. Share it with the link below."
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
					className: "saved-link-box",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
						className: "saved-link-text",
						children: savedLink
					}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("button", {
						className: "saved-copy-btn",
						onClick: handleCopy,
						children: copied ? /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("svg", {
							width: "14",
							height: "14",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "#22c55e",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("polyline", { points: "20 6 9 17 4 12" })
						}) : /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
							width: "14",
							height: "14",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("rect", {
								x: "9",
								y: "9",
								width: "13",
								height: "13",
								rx: "2",
								ry: "2"
							}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })]
						})
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
					className: "saved-actions",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("button", {
						className: "saved-open-btn",
						onClick: handleOpen,
						children: "Open Recording"
					}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("button", {
						className: "saved-close-btn",
						onClick: () => setSavedLink(null),
						children: "New Recording"
					})]
				})
			]
		})
	});
	return /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
		className: "container",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
				className: "header",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
					className: "logo",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
						className: "logo-icon",
						children: "⬤"
					}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
						className: "logo-text",
						children: "DevRecorder"
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
					className: `status-badge ${isRecording ? "recording" : ""}`,
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { className: `status-dot ${isRecording ? "recording" : ""}` }), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { children: isRecording ? "Recording" : "Ready" })]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
				className: "timer-section",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
					className: `timer ${isRecording ? "active" : ""}`,
					children: elapsed
				}), isRecording && /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", { className: "timer-glow" })]
			}),
			!isRecording && /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
				className: "mode-selector",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("button", {
					className: `mode-btn ${mode === "window" ? "active" : ""}`,
					onClick: () => setMode("window"),
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
						width: "16",
						height: "16",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("rect", {
								x: "2",
								y: "3",
								width: "20",
								height: "14",
								rx: "2",
								ry: "2"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "8",
								y1: "21",
								x2: "16",
								y2: "21"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
								x1: "12",
								y1: "17",
								x2: "12",
								y2: "21"
							})
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { children: "Window" })]
				}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("button", {
					className: `mode-btn ${mode === "region" ? "active" : ""}`,
					onClick: () => setMode("region"),
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
						width: "16",
						height: "16",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M6 2L2 6" }),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M2 12v-2" }),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M2 18l4 4" }),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M12 2h2" }),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M18 2l4 4" }),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M22 12v2" }),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M22 18l-4 4" }),
							/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M12 22h-2" })
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { children: "Region" })]
				})]
			}),
			!isRecording && /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("button", {
				className: `mic-btn ${micEnabled ? "enabled" : ""}`,
				onClick: async () => {
					try {
						(await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
						setMicEnabled(true);
					} catch {
						setMicEnabled(false);
					}
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
					width: "14",
					height: "14",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" }),
						/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
						/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
							x1: "12",
							y1: "19",
							x2: "12",
							y2: "22"
						})
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { children: micEnabled ? "Microphone On" : "Enable Microphone" })]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
				className: "actions",
				children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("button", {
					className: `btn-record ${isRecording ? "recording" : ""} ${loading ? "disabled" : ""}`,
					onClick: handleRecord,
					disabled: loading,
					children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
						className: "btn-icon",
						children: isRecording ? "■" : "●"
					}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { children: isRecording ? "Stop Recording" : "Start Recording" })]
				})
			}),
			error && /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
				className: "error",
				children: error
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
				className: "footer",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("button", {
						className: "btn-viewer",
						onClick: () => {
							chrome.tabs.create({ url: FRONTEND_URL });
							window.close();
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
							width: "14",
							height: "14",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("polygon", { points: "23 7 16 12 23 17 23 7" }), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("rect", {
								x: "1",
								y: "5",
								width: "15",
								height: "14",
								rx: "2",
								ry: "2"
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { children: "View Recordings" })]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("button", {
						className: "theme-toggle",
						onClick: toggleTheme,
						title: `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
						children: theme === "dark" ? /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "5"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "12",
									y1: "1",
									x2: "12",
									y2: "3"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "12",
									y1: "21",
									x2: "12",
									y2: "23"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "4.22",
									y1: "4.22",
									x2: "5.64",
									y2: "5.64"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "18.36",
									y1: "18.36",
									x2: "19.78",
									y2: "19.78"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "1",
									y1: "12",
									x2: "3",
									y2: "12"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "21",
									y1: "12",
									x2: "23",
									y2: "12"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "4.22",
									y1: "19.78",
									x2: "5.64",
									y2: "18.36"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "18.36",
									y1: "5.64",
									x2: "19.78",
									y2: "4.22"
								})
							]
						}) : /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" })
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("button", {
						className: "btn-signout",
						onClick: handleSignOut,
						title: "Sign out",
						children: /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("svg", {
							width: "14",
							height: "14",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("polyline", { points: "16 17 21 12 16 7" }),
								/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("line", {
									x1: "21",
									y1: "12",
									x2: "9",
									y2: "12"
								})
							]
						})
					})
				]
			})
		]
	});
}
var import_react$1, import_jsx_runtime$1, FRONTEND_URL;
var init_Popup = __esmMin((() => {
	import_react$1 = require_react();
	init_types();
	import_jsx_runtime$1 = require_jsx_runtime();
	FRONTEND_URL = "https://www.devrecorder.com";
}));
//#endregion
//#region src/popup/popup.css
var init_popup = __esmMin((() => {}));
(/* @__PURE__ */ __commonJSMin((() => {
	var import_react = require_react();
	var import_client = require_client();
	init_Popup();
	init_popup();
	var import_jsx_runtime = require_jsx_runtime();
	(0, import_client.createRoot)(document.getElementById("root")).render(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react.StrictMode, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Popup, {}) }));
})))();
//#endregion

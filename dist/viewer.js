import { n as __esmMin, t as __commonJSMin } from "./assets/chunk-C9LnQP83.js";
import "./assets/modulepreload-polyfill-aOyzcF2x.js";
import { n as require_client, r as require_react, t as require_jsx_runtime } from "./assets/jsx-runtime-ygBq2LhR.js";
import { n as init_api, t as api } from "./assets/api-CH9pI5WW.js";
//#region src/viewer/utils.ts
function formatDuration(ms) {
	if (!ms) return "0:00";
	const totalSec = Math.floor(ms / 1e3);
	return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}
function formatTime(ms) {
	if (ms < 0) ms = 0;
	const totalSec = Math.floor(ms / 1e3);
	return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}.${String(Math.floor(ms % 1e3 / 10)).padStart(2, "0")}`;
}
function formatDate(ts) {
	return new Date(ts).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit"
	});
}
var init_utils = __esmMin((() => {}));
//#endregion
//#region src/viewer/RecordingList.tsx
function RecordingList({ recordings, onSelect, onDelete }) {
	const [copiedId, setCopiedId] = (0, import_react$5.useState)(null);
	const handleShare = (e, rec) => {
		e.stopPropagation();
		if (!rec.videoUrl) return;
		navigator.clipboard.writeText(rec.videoUrl).then(() => {
			setCopiedId(rec._id);
			setTimeout(() => setCopiedId(null), 2e3);
		});
	};
	return /* @__PURE__ */ (0, import_jsx_runtime$5.jsx)("div", {
		className: "recordings-grid",
		children: recordings.map((rec) => /* @__PURE__ */ (0, import_jsx_runtime$5.jsxs)("div", {
			className: "rec-card",
			onClick: () => onSelect(rec._id),
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime$5.jsx)("div", {
					className: "rec-card-thumb",
					children: "▶"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$5.jsxs)("div", {
					className: "rec-card-body",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$5.jsx)("div", {
						className: "rec-card-title",
						children: rec.title
					}), /* @__PURE__ */ (0, import_jsx_runtime$5.jsxs)("div", {
						className: "rec-card-meta",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$5.jsx)("span", { children: formatDuration(rec.duration) }), /* @__PURE__ */ (0, import_jsx_runtime$5.jsx)("span", { children: formatDate(new Date(rec.createdAt).getTime()) })]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$5.jsxs)("div", {
					className: "rec-card-actions",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$5.jsx)("button", {
						className: "rec-card-share",
						onClick: (e) => handleShare(e, rec),
						title: "Copy share link",
						children: copiedId === rec._id ? "Copied!" : "Share"
					}), /* @__PURE__ */ (0, import_jsx_runtime$5.jsx)("button", {
						className: "rec-card-delete",
						onClick: (e) => {
							e.stopPropagation();
							onDelete(rec._id);
						},
						children: "Delete"
					})]
				})
			]
		}, rec._id))
	});
}
var import_react$5, import_jsx_runtime$5;
var init_RecordingList = __esmMin((() => {
	import_react$5 = require_react();
	init_utils();
	import_jsx_runtime$5 = require_jsx_runtime();
}));
//#endregion
//#region src/viewer/EventRow.tsx
function EventRow({ event, isActive, isSelected, onClick }) {
	const [expanded, setExpanded] = (0, import_react$4.useState)(false);
	const time = formatTime(event.relativeTime);
	return /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)("div", {
		className: [
			"event-row",
			isActive ? "active" : "",
			isSelected ? "selected" : "",
			expanded ? "expanded" : ""
		].filter(Boolean).join(" "),
		onClick,
		onDoubleClick: () => setExpanded(!expanded),
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
				className: "event-time",
				children: time
			}),
			event.type === "console" && /* @__PURE__ */ (0, import_jsx_runtime$4.jsx)(ConsoleEvent, { data: event.data }),
			event.type === "network" && /* @__PURE__ */ (0, import_jsx_runtime$4.jsx)(NetworkEvent, { data: event.data }),
			event.type === "navigation" && /* @__PURE__ */ (0, import_jsx_runtime$4.jsx)(NavigationEvent, { data: event.data })
		]
	});
}
function ConsoleEvent({ data }) {
	return /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)(import_jsx_runtime$4.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
		className: `event-badge badge-${data.level}`,
		children: data.level
	}), /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)("div", {
		className: "event-content",
		children: [/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", { children: data.args.join(" ") }), data.stack && /* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
			className: "stack",
			children: data.stack
		})]
	})] });
}
function NetworkEvent({ data }) {
	const badgeClass = getBadgeClass$1(data.method);
	const statusClass = getStatusClass$1(data.status);
	const url = truncateUrl(data.url);
	return /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)(import_jsx_runtime$4.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
		className: `event-badge ${badgeClass}`,
		children: data.method
	}), /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)("div", {
		className: "event-content",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
				className: "url",
				children: url
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
				className: `status ${statusClass}`,
				children: data.status || "ERR"
			}),
			data.duration > 0 && /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)("span", {
				className: "duration",
				children: [Math.round(data.duration), "ms"]
			}),
			data.error && /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)("span", {
				className: "error-text",
				children: [" ", data.error]
			})
		]
	})] });
}
function NavigationEvent({ data }) {
	return /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)(import_jsx_runtime$4.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
		className: "event-badge badge-nav",
		children: "NAV"
	}), /* @__PURE__ */ (0, import_jsx_runtime$4.jsxs)("div", {
		className: "event-content",
		children: [/* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
			className: "nav-url",
			children: data.url
		}), /* @__PURE__ */ (0, import_jsx_runtime$4.jsx)("span", {
			className: "transition",
			children: data.transitionType
		})]
	})] });
}
function getBadgeClass$1(method) {
	return {
		GET: "badge-get",
		POST: "badge-post",
		PUT: "badge-put",
		DELETE: "badge-delete",
		PATCH: "badge-patch"
	}[method.toUpperCase()] || "badge-other-method";
}
function getStatusClass$1(status) {
	if (!status || status === 0) return "status-0";
	if (status < 300) return "status-2xx";
	if (status < 400) return "status-3xx";
	if (status < 500) return "status-4xx";
	return "status-5xx";
}
function truncateUrl(url) {
	if (!url) return "";
	try {
		const u = new URL(url);
		const path = u.pathname + u.search;
		return path.length > 80 ? path.slice(0, 77) + "..." : path;
	} catch {
		return url.length > 80 ? url.slice(0, 77) + "..." : url;
	}
}
var import_react$4, import_jsx_runtime$4;
var init_EventRow = __esmMin((() => {
	import_react$4 = require_react();
	init_utils();
	import_jsx_runtime$4 = require_jsx_runtime();
}));
//#endregion
//#region src/viewer/NetworkDetail.tsx
function NetworkDetail({ data, relativeTime, onClose }) {
	const [tab, setTab] = (0, import_react$3.useState)("headers");
	return /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
		className: "net-detail",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
				className: "net-detail-header",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
					className: "net-detail-title",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: `event-badge ${getBadgeClass(data.method)}`,
							children: data.method
						}),
						/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: `net-detail-status ${getStatusClass(data.status)}`,
							children: data.status || "ERR"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-detail-time",
							children: formatTime(relativeTime)
						}),
						/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-detail-dur",
							children: data.duration > 0 ? `${Math.round(data.duration)}ms` : ""
						})
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("button", {
					className: "net-detail-close",
					onClick: onClose,
					children: "×"
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
				className: "net-detail-url",
				children: data.url
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
				className: "net-detail-tabs",
				children: [
					{
						label: "Headers",
						value: "headers"
					},
					{
						label: "Payload",
						value: "payload"
					},
					{
						label: "Response",
						value: "response"
					}
				].map((t) => /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("button", {
					className: `net-detail-tab ${tab === t.value ? "active" : ""}`,
					onClick: () => setTab(t.value),
					children: t.label
				}, t.value))
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
				className: "net-detail-body",
				children: [
					tab === "headers" && /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)(HeadersView, { data }),
					tab === "payload" && /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)(PayloadView, { body: data.requestBody }),
					tab === "response" && /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)(ResponseView, { body: data.responseBody })
				]
			})
		]
	});
}
function HeadersView({ data }) {
	const reqHeaders = Object.entries(data.requestHeaders || {});
	const resHeaders = Object.entries(data.responseHeaders || {});
	return /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
		className: "net-headers",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
				className: "net-headers-section",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
						className: "net-headers-title",
						children: "General"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
						className: "net-header-row",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-name",
							children: "Request URL"
						}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-value",
							children: data.url
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
						className: "net-header-row",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-name",
							children: "Request Method"
						}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-value",
							children: data.method
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
						className: "net-header-row",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-name",
							children: "Status Code"
						}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: `net-header-value ${getStatusClass(data.status)}`,
							children: data.statusLine || data.status
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
						className: "net-header-row",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-name",
							children: "Resource Type"
						}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-value",
							children: data.resourceType
						})]
					}),
					data.initiator && /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
						className: "net-header-row",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-name",
							children: "Initiator"
						}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
							className: "net-header-value",
							children: data.initiator
						})]
					})
				]
			}),
			resHeaders.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
				className: "net-headers-section",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
					className: "net-headers-title",
					children: [
						"Response Headers (",
						resHeaders.length,
						")"
					]
				}), resHeaders.map(([name, value]) => /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
					className: "net-header-row",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
						className: "net-header-name",
						children: name
					}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
						className: "net-header-value",
						children: value
					})]
				}, name))]
			}),
			reqHeaders.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
				className: "net-headers-section",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
					className: "net-headers-title",
					children: [
						"Request Headers (",
						reqHeaders.length,
						")"
					]
				}), reqHeaders.map(([name, value]) => /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
					className: "net-header-row",
					children: [/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
						className: "net-header-name",
						children: name
					}), /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("span", {
						className: "net-header-value",
						children: value
					})]
				}, name))]
			})
		]
	});
}
function PayloadView({ body }) {
	if (!body) return /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
		className: "net-empty",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
				className: "net-empty-icon",
				children: "📦"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", { children: "No request payload" }),
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
				className: "net-empty-hint",
				children: "This request did not include a body (e.g. GET requests)"
			})
		]
	});
	return /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
		className: "net-body-view",
		children: /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("pre", {
			className: "net-body-pre",
			children: tryFormatJson(body)
		})
	});
}
function ResponseView({ body }) {
	if (!body) return /* @__PURE__ */ (0, import_jsx_runtime$3.jsxs)("div", {
		className: "net-empty",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
				className: "net-empty-icon",
				children: "📄"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", { children: "Response body not available" }),
			/* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
				className: "net-empty-hint",
				children: "Response bodies are not captured during recording to avoid the browser debug bar"
			})
		]
	});
	return /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("div", {
		className: "net-body-view",
		children: /* @__PURE__ */ (0, import_jsx_runtime$3.jsx)("pre", {
			className: "net-body-pre",
			children: tryFormatJson(body)
		})
	});
}
function tryFormatJson(str) {
	try {
		return JSON.stringify(JSON.parse(str), null, 2);
	} catch {
		return str;
	}
}
function getBadgeClass(method) {
	return {
		GET: "badge-get",
		POST: "badge-post",
		PUT: "badge-put",
		DELETE: "badge-delete",
		PATCH: "badge-patch"
	}[method.toUpperCase()] || "badge-other-method";
}
function getStatusClass(status) {
	if (!status || status === 0) return "status-0";
	if (status < 300) return "status-2xx";
	if (status < 400) return "status-3xx";
	if (status < 500) return "status-4xx";
	return "status-5xx";
}
var import_react$3, import_jsx_runtime$3;
var init_NetworkDetail = __esmMin((() => {
	import_react$3 = require_react();
	init_utils();
	import_jsx_runtime$3 = require_jsx_runtime();
}));
//#endregion
//#region src/viewer/Playback.tsx
function Playback({ recordingId, onBack, onDelete }) {
	const [recording, setRecording] = (0, import_react$2.useState)(null);
	const [events, setEvents] = (0, import_react$2.useState)([]);
	const [filter, setFilter] = (0, import_react$2.useState)("all");
	const [activeTime, setActiveTime] = (0, import_react$2.useState)(0);
	const [selectedEvent, setSelectedEvent] = (0, import_react$2.useState)(null);
	const [scrollPaused, setScrollPaused] = (0, import_react$2.useState)(false);
	const videoRef = (0, import_react$2.useRef)(null);
	const eventsListRef = (0, import_react$2.useRef)(null);
	const scrollPauseTimerRef = (0, import_react$2.useRef)(null);
	(0, import_react$2.useEffect)(() => {
		(async () => {
			const rec = await api.getRecording(recordingId);
			if (!rec) return;
			setRecording(rec);
			if (rec.videoUrl && videoRef.current) videoRef.current.src = rec.videoUrl;
			setEvents(await api.getEvents(recordingId));
		})();
	}, [recordingId]);
	const handleTimeUpdate = (0, import_react$2.useCallback)(() => {
		if (!videoRef.current) return;
		setActiveTime(videoRef.current.currentTime * 1e3);
	}, []);
	const seekTo = (ms) => {
		if (!videoRef.current) return;
		videoRef.current.currentTime = ms / 1e3;
		videoRef.current.play();
	};
	const handleEventClick = (event) => {
		if (event.type === "network") {
			setSelectedEvent(event);
			pauseScroll();
		} else seekTo(event.relativeTime);
	};
	const pauseScroll = () => {
		setScrollPaused(true);
		if (scrollPauseTimerRef.current) clearTimeout(scrollPauseTimerRef.current);
		scrollPauseTimerRef.current = setTimeout(() => {
			setScrollPaused(false);
		}, 1e4);
	};
	const handleListScroll = () => {
		pauseScroll();
	};
	const handleExport = () => {
		if (!recording?.videoUrl) return;
		const a = document.createElement("a");
		a.href = recording.videoUrl;
		a.download = `${recording.title.replace(/[^a-zA-Z0-9]/g, "_")}.webm`;
		a.click();
	};
	const filtered = filter === "all" ? events : events.filter((e) => e.type === filter);
	const tabs = [
		{
			label: "All",
			value: "all"
		},
		{
			label: "Console",
			value: "console"
		},
		{
			label: "Network",
			value: "network"
		},
		{
			label: "Navigation",
			value: "navigation"
		}
	];
	(0, import_react$2.useEffect)(() => {
		if (scrollPaused || !eventsListRef.current) return;
		const activeRow = eventsListRef.current.querySelector(".event-row.active");
		if (activeRow) {
			const container = eventsListRef.current;
			const rowTop = activeRow.offsetTop;
			const containerScroll = container.scrollTop;
			const containerHeight = container.clientHeight;
			if (rowTop < containerScroll || rowTop > containerScroll + containerHeight - 40) container.scrollTop = rowTop - containerHeight / 3;
		}
	}, [activeTime, scrollPaused]);
	return /* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("div", {
		className: "view",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("header", {
				className: "top-bar",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("button", {
						className: "btn-back",
						onClick: onBack,
						children: "← Back"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("div", {
						className: "rec-title",
						children: recording?.title || "Loading..."
					}),
					/* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("div", {
						className: "rec-actions",
						children: [/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("button", {
							className: "btn-action",
							onClick: handleExport,
							children: "⬇ Download"
						}), /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("button", {
							className: "btn-action btn-delete",
							onClick: onDelete,
							children: "🗑 Delete"
						})]
					})
				]
			}),
			recording && /* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("div", {
				className: "video-meta",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("span", { children: formatDuration(recording.duration) }),
					/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("span", { children: recording.url }),
					/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("span", { children: formatDate(new Date(recording.createdAt).getTime()) })
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("div", {
				className: "playback-layout",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("div", {
					className: "video-panel",
					children: /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("video", {
						ref: videoRef,
						controls: true,
						onTimeUpdate: handleTimeUpdate
					})
				}), /* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("div", {
					className: "events-panel",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("div", {
							className: "events-tabs",
							children: tabs.map((t) => /* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("button", {
								className: `tab ${filter === t.value ? "active" : ""}`,
								onClick: () => {
									setFilter(t.value);
									setSelectedEvent(null);
								},
								children: [t.label, t.value !== "all" && /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("span", {
									className: "tab-count",
									children: events.filter((e) => e.type === t.value).length
								})]
							}, t.value))
						}),
						selectedEvent && selectedEvent.type === "network" ? /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)(NetworkDetail, {
							data: selectedEvent.data,
							relativeTime: selectedEvent.relativeTime,
							onClose: () => setSelectedEvent(null)
						}) : /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("div", {
							className: "events-list",
							ref: eventsListRef,
							onScroll: handleListScroll,
							children: filtered.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("div", {
								className: "events-empty",
								children: "No events"
							}) : filtered.map((event) => /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)(EventRow, {
								event,
								isActive: !scrollPaused && event.relativeTime <= activeTime && event.relativeTime > activeTime - 1e3,
								isSelected: selectedEvent?._id === event._id,
								onClick: () => handleEventClick(event)
							}, event._id))
						}),
						scrollPaused && !selectedEvent && /* @__PURE__ */ (0, import_jsx_runtime$2.jsxs)("div", {
							className: "scroll-paused-bar",
							children: [/* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("span", { children: "Auto-scroll paused" }), /* @__PURE__ */ (0, import_jsx_runtime$2.jsx)("button", {
								onClick: () => setScrollPaused(false),
								children: "Resume"
							})]
						})
					]
				})]
			})
		]
	});
}
var import_react$2, import_jsx_runtime$2;
var init_Playback = __esmMin((() => {
	import_react$2 = require_react();
	init_api();
	init_EventRow();
	init_NetworkDetail();
	init_utils();
	import_jsx_runtime$2 = require_jsx_runtime();
}));
//#endregion
//#region src/viewer/Viewer.tsx
function Viewer() {
	const [recordingId, setRecordingId] = (0, import_react$1.useState)(() => {
		return new URLSearchParams(window.location.search).get("id");
	});
	const [recordings, setRecordings] = (0, import_react$1.useState)([]);
	const [loading, setLoading] = (0, import_react$1.useState)(true);
	const loadRecordings = async () => {
		setLoading(true);
		setRecordings(await api.getRecordings());
		setLoading(false);
	};
	(0, import_react$1.useEffect)(() => {
		loadRecordings();
	}, []);
	const handleSelect = (id) => {
		setRecordingId(id);
		window.history.pushState({}, "", `?id=${id}`);
	};
	const handleBack = () => {
		setRecordingId(null);
		window.history.pushState({}, "", window.location.pathname);
		loadRecordings();
	};
	const handleDelete = async (id) => {
		if (!confirm("Delete this recording permanently?")) return;
		await api.deleteRecording(id);
		if (recordingId === id) handleBack();
		else loadRecordings();
	};
	if (recordingId !== null) return /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)(Playback, {
		recordingId,
		onBack: handleBack,
		onDelete: () => handleDelete(recordingId)
	});
	return /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
		className: "view",
		children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("header", {
			className: "top-bar",
			children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
				className: "logo",
				children: [/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
					className: "logo-icon",
					children: "⬤"
				}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", { children: "DevLoom" })]
			}), /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("span", {
				className: "subtitle",
				children: "Recordings"
			})]
		}), loading ? /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
			className: "empty-state",
			children: "Loading..."
		}) : recordings.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime$1.jsxs)("div", {
			className: "empty-state",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
					className: "empty-icon",
					children: "📹"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
					className: "empty-title",
					children: "No recordings yet"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime$1.jsx)("div", {
					className: "empty-text",
					children: "Start a recording from the DevLoom extension popup."
				})
			]
		}) : /* @__PURE__ */ (0, import_jsx_runtime$1.jsx)(RecordingList, {
			recordings,
			onSelect: handleSelect,
			onDelete: handleDelete
		})]
	});
}
var import_react$1, import_jsx_runtime$1;
var init_Viewer = __esmMin((() => {
	import_react$1 = require_react();
	init_api();
	init_RecordingList();
	init_Playback();
	import_jsx_runtime$1 = require_jsx_runtime();
}));
//#endregion
//#region src/viewer/viewer.css
var init_viewer = __esmMin((() => {}));
(/* @__PURE__ */ __commonJSMin((() => {
	var import_react = require_react();
	var import_client = require_client();
	init_Viewer();
	init_viewer();
	var import_jsx_runtime = require_jsx_runtime();
	(0, import_client.createRoot)(document.getElementById("root")).render(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react.StrictMode, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Viewer, {}) }));
})))();
//#endregion

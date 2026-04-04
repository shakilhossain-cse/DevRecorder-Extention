(function() {
	//#region src/content/page-agent.ts
	(() => {
		if (window.__devloomPageAgent) return;
		window.__devloomPageAgent = true;
		const original = {
			log: console.log.bind(console),
			warn: console.warn.bind(console),
			error: console.error.bind(console),
			info: console.info.bind(console),
			debug: console.debug.bind(console)
		};
		[
			"log",
			"warn",
			"error",
			"info",
			"debug"
		].forEach((level) => {
			console[level] = function(...args) {
				original[level](...args);
				const serialized = args.map((arg) => {
					try {
						if (arg instanceof Error) return arg.stack || arg.message;
						if (typeof arg === "object") return JSON.stringify(arg, null, 2);
						return String(arg);
					} catch {
						return "[Unserializable]";
					}
				});
				window.postMessage({
					source: "devloom-page-agent",
					type: "console",
					level,
					args: serialized,
					timestamp: Date.now(),
					stack: (/* @__PURE__ */ new Error()).stack?.split("\n").slice(2).join("\n") || ""
				}, "*");
			};
		});
		window.addEventListener("error", (e) => {
			window.postMessage({
				source: "devloom-page-agent",
				type: "console",
				level: "error",
				args: [`Uncaught ${e.error?.message || e.message}`],
				timestamp: Date.now(),
				stack: e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`
			}, "*");
		});
		window.addEventListener("unhandledrejection", (e) => {
			window.postMessage({
				source: "devloom-page-agent",
				type: "console",
				level: "error",
				args: [`Unhandled Promise Rejection: ${e.reason?.message || e.reason}`],
				timestamp: Date.now(),
				stack: e.reason?.stack || ""
			}, "*");
		});
		const originalFetch = window.fetch.bind(window);
		window.fetch = async function(...args) {
			const req = new Request(...args);
			const url = req.url;
			const method = req.method;
			let requestBody = null;
			try {
				requestBody = await req.clone().text();
			} catch {}
			try {
				const response = await originalFetch(...args);
				const clone = response.clone();
				let responseBody = null;
				try {
					const ct = clone.headers.get("content-type") || "";
					if (ct.includes("json") || ct.includes("text") || ct.includes("xml") || ct.includes("html")) {
						const text = await clone.text();
						if (text.length < 1e5) responseBody = text;
					}
				} catch {}
				window.postMessage({
					source: "devloom-page-agent",
					type: "network-response",
					url,
					method,
					status: response.status,
					requestBody,
					responseBody,
					timestamp: Date.now()
				}, "*");
				return response;
			} catch (err) {
				throw err;
			}
		};
		const OrigXHR = window.XMLHttpRequest;
		const origOpen = OrigXHR.prototype.open;
		const origSend = OrigXHR.prototype.send;
		OrigXHR.prototype.open = function(method, url, ...rest) {
			this.__devloom = {
				method,
				url: String(url)
			};
			return origOpen.apply(this, [
				method,
				url,
				...rest
			]);
		};
		OrigXHR.prototype.send = function(body) {
			const meta = this.__devloom;
			if (meta) {
				let requestBody = null;
				if (typeof body === "string") requestBody = body;
				this.addEventListener("load", function() {
					let responseBody = null;
					try {
						const ct = this.getResponseHeader("content-type") || "";
						if (ct.includes("json") || ct.includes("text") || ct.includes("xml")) {
							if (this.responseText.length < 1e5) responseBody = this.responseText;
						}
					} catch {}
					window.postMessage({
						source: "devloom-page-agent",
						type: "network-response",
						url: meta.url,
						method: meta.method,
						status: this.status,
						requestBody,
						responseBody,
						timestamp: Date.now()
					}, "*");
				});
			}
			return origSend.apply(this, [body]);
		};
	})();
	//#endregion
})();

(function() {
	//#region src/content/content.ts
	(() => {
		const script = document.createElement("script");
		script.src = chrome.runtime.getURL("content/page-agent.js");
		script.onload = () => script.remove();
		(document.head || document.documentElement).appendChild(script);
		window.addEventListener("message", (event) => {
			if (event.source !== window) return;
			if (!event.data || event.data.source !== "devloom-page-agent") return;
			try {
				if (event.data.type === "console") chrome.runtime.sendMessage({
					type: "CONSOLE_EVENT",
					data: {
						level: event.data.level,
						args: event.data.args,
						timestamp: event.data.timestamp,
						stack: event.data.stack
					}
				}).catch(() => {});
				else if (event.data.type === "network-response") chrome.runtime.sendMessage({
					type: "NETWORK_RESPONSE",
					data: {
						url: event.data.url,
						method: event.data.method,
						status: event.data.status,
						requestBody: event.data.requestBody,
						responseBody: event.data.responseBody,
						timestamp: event.data.timestamp
					}
				}).catch(() => {});
			} catch {}
		});
	})();
	//#endregion
})();

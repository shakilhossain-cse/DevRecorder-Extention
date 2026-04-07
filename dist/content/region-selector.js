(function(){(()=>{if(document.getElementById(`devrecorder-region-overlay`))return;let e=document.createElement(`div`);e.id=`devrecorder-region-overlay`,e.style.cssText=`
    position:fixed;inset:0;z-index:2147483647;
    background:rgba(0,0,0,0.4);cursor:crosshair;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  `;let t=document.createElement(`div`);t.textContent=`Drag to select the region to record. Press Esc to cancel.`,t.style.cssText=`
    position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;
    background:#1a1b2e;color:#e0e0e8;padding:10px 20px;border-radius:8px;
    font-size:14px;font-weight:500;pointer-events:none;
    box-shadow:0 4px 20px rgba(0,0,0,0.5);
  `,e.appendChild(t);let n=document.createElement(`div`);n.style.cssText=`
    position:fixed;border:2px solid #6a7bff;background:rgba(106,123,255,0.1);
    display:none;z-index:2147483647;pointer-events:none;
  `,e.appendChild(n);let r=document.createElement(`div`);r.style.cssText=`
    position:fixed;background:#6a7bff;color:#fff;padding:3px 8px;
    border-radius:4px;font-size:11px;font-weight:600;
    pointer-events:none;display:none;z-index:2147483647;
  `,e.appendChild(r);let i=0,a=0,o=!1;e.onmousedown=e=>{e.preventDefault(),o=!0,i=e.clientX,a=e.clientY,n.style.display=`block`,n.style.left=`${i}px`,n.style.top=`${a}px`,n.style.width=`0px`,n.style.height=`0px`,r.style.display=`block`,t.style.display=`none`},e.onmousemove=e=>{if(!o)return;let t=Math.min(i,e.clientX),s=Math.min(a,e.clientY),c=Math.abs(e.clientX-i),l=Math.abs(e.clientY-a);n.style.left=`${t}px`,n.style.top=`${s}px`,n.style.width=`${c}px`,n.style.height=`${l}px`,r.style.left=`${t}px`,r.style.top=`${s+l+6}px`,r.textContent=`${c} × ${l}`},e.onmouseup=t=>{if(!o)return;o=!1;let n=Math.min(i,t.clientX),r=Math.min(a,t.clientY),u=Math.abs(t.clientX-i),d=Math.abs(t.clientY-a);if(u<20||d<20){c(),chrome.runtime.sendMessage({type:`REGION_CANCELLED`});return}e.remove(),document.removeEventListener(`keydown`,s),l(n,r,u,d);let f=window.devicePixelRatio||1;chrome.runtime.sendMessage({type:`REGION_SELECTED`,rect:{x:Math.round(n*f),y:Math.round(r*f),width:Math.round(u*f),height:Math.round(d*f)}})};function s(e){e.key===`Escape`&&(c(),chrome.runtime.sendMessage({type:`REGION_CANCELLED`}))}document.addEventListener(`keydown`,s);function c(){e.remove(),document.removeEventListener(`keydown`,s)}function l(e,t,n,r){let i=document.createElement(`div`);i.id=`devrecorder-region-border`,i.style.cssText=`
      position:fixed;left:${e}px;top:${t}px;width:${n}px;height:${r}px;
      border:2px dashed #6a7bff;border-radius:4px;
      z-index:2147483646;pointer-events:none;
      box-shadow:0 0 0 9999px rgba(0,0,0,0.15);
    `,document.body.appendChild(i),chrome.runtime.onMessage.addListener(function e(t){t&&t.type===`DEVRECORDER_REMOVE_DRAWING`&&(i.remove(),chrome.runtime.onMessage.removeListener(e))})}document.body.appendChild(e)})()})();
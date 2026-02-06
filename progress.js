const bar = document.getElementById("bar");
const pct = document.getElementById("pct");
const text = document.getElementById("text");

function poll() {
  chrome.runtime.sendMessage({ type: "GET_PROGRESS" }, (p) => {
    if (!p) return;
    bar.style.width = (p.pct || 0) + "%";
    pct.textContent = (p.pct || 0) + "%";
    text.textContent = p.text || "";
  });
}

poll();
setInterval(poll, 1000);

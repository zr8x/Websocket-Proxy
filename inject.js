(function () {
  var PROXY = "proxy://";
  var pending = {};

  function resolve(url) {
    return new Promise(function (res) {
      var id = "r" + Math.random().toString(36).slice(2);
      pending[id] = res;
      window.parent.postMessage({ cmd: "resource", url: url, id: id }, "*");
    });
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.cmd !== "resolved" || !pending[d.id]) return;
    var p = pending[d.id];
    delete pending[d.id];
    var resolved = d.ok && d.blobUrl ? d.blobUrl : d.url || "";
    if (!resolved) resolved = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    p(resolved);
  });

  var TAGS = [
    ["img", "src"],
    ["iframe", "src"],
    ["script", "src"],
    ["video", "src"],
    ["audio", "src"],
    ["source", "src"],
    ["input", "src"],
    ["embed", "src"],
    ["track", "src"],
    ["link", "href"],
    ["video", "poster"],
    ["object", "data"]
  ];

  function selector() {
    var s = [];
    for (var i = 0; i < TAGS.length; i++) {
      s.push(TAGS[i][0] + "[" + TAGS[i][1] + "^='" + PROXY + "']");
    }
    return s.join(",");
  }

  function attrFor(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    for (var i = 0; i < TAGS.length; i++) {
      if (TAGS[i][0] === tag) return TAGS[i][1];
    }
    return null;
  }

  function proxyUrl(el, attr) {
    var v = el.getAttribute(attr);
    if (v && v.indexOf(PROXY) === 0) return v.slice(PROXY.length);
    return null;
  }

  function fixEl(el) {
    if (el.nodeType !== 1) return;
    var ds = el.getAttribute && el.getAttribute("data-src");
    if (ds && ds.indexOf(PROXY) === 0) {
      el.setAttribute("data-px", "1");
      resolve(ds.slice(PROXY.length)).then(function (resolved) {
        el.setAttribute("src", resolved);
      });
      return;
    }
    var attr = attrFor(el);
    var url = attr ? proxyUrl(el, attr) : null;
    if (url) {
      el.setAttribute("data-px", "1");
      resolve(url).then(function (resolved) {
        el.setAttribute(attr, resolved);
      });
      return;
    }
    fixDescendants(el);
  }

  function fixDescendants(root) {
    if (!root || !root.querySelectorAll) return;
    var ds = root.querySelectorAll('[data-src^="' + PROXY + '"]');
    for (var i = 0; i < ds.length; i++) {
      (function (el) {
        if (el.getAttribute("data-px")) return;
        el.setAttribute("data-px", "1");
        resolve(el.getAttribute("data-src").slice(PROXY.length)).then(function (resolved) {
          el.setAttribute("src", resolved);
        });
      })(ds[i]);
    }
    var els = root.querySelectorAll(selector());
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var attr = attrFor(el);
        var url = proxyUrl(el, attr);
        if (!url || el.getAttribute("data-px")) return;
        el.setAttribute("data-px", "1");
        resolve(url).then(function (resolved) {
          el.setAttribute(attr, resolved);
        });
      })(els[i]);
    }
    fixSrcset(root);
  }

  function fixSrcset(root) {
    if (!root || !root.querySelectorAll) return;
    var els = root.querySelectorAll("[srcset]");
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var val = el.getAttribute("srcset") || "";
        var parts = val.split(",");
        for (var j = 0; j < parts.length; j++) {
          (function (toks) {
            if (toks[0] && toks[0].indexOf(PROXY) === 0) {
              resolve(toks[0].slice(PROXY.length)).then(function (resolved) {
                toks[0] = resolved;
                var out = [];
                for (var k = 0; k < parts.length; k++) {
                  out.push(parts[k].trim());
                }
                el.setAttribute("srcset", out.join(", "));
              });
            }
          })(parts[j].trim().split(/\s+/));
        }
      })(els[i]);
    }
  }

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href^='" + PROXY + "']") : null;
      if (!a) return;
      e.stopPropagation();
      e.preventDefault();
      window.parent.postMessage({ cmd: "navigate", url: a.getAttribute("href").slice(PROXY.length) }, "*");
    },
    true
  );

  document.addEventListener(
    "submit",
    function (e) {
      var f = e.target;
      if (!f || f.tagName.toLowerCase() !== "form") return;
      var action = f.getAttribute("action") || "";
      if (action.indexOf(PROXY) !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      var url = action.slice(PROXY.length);
      var method = (f.getAttribute("method") || "get").toLowerCase();
      var fd = new FormData(f);
      var params = new URLSearchParams(fd).toString();
      if (method === "post") {
        window.parent.postMessage(
          { cmd: "fetch", url: url, method: "POST", body: params, contentType: "application/x-www-form-urlencoded" },
          "*"
        );
      } else {
        if (params) url = url + (url.indexOf("?") >= 0 ? "&" : "?") + params;
        window.parent.postMessage({ cmd: "navigate", url: url }, "*");
      }
    },
    true
  );

  function reportTitle() {
    window.parent.postMessage({ cmd: "title", title: document.title }, "*");
  }
  document.addEventListener("DOMContentLoaded", reportTitle);
  setInterval(reportTitle, 2000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      fixDescendants(document);
    });
  } else {
    fixDescendants(document);
  }

  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes;
        if (!nodes) continue;
        for (var j = 0; j < nodes.length; j++) fixEl(nodes[j]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
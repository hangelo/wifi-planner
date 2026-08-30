/* ============================================================
   consent.js — cookie banner and gated analytics

   Google Analytics sets cookies, so it is not loaded until the
   visitor has said yes: on a decline the script is never fetched
   at all, rather than fetched and told to behave. Declining is
   not a dead end — nothing else about the page changes.
   ============================================================ */
"use strict";

(function(){

const KEY = "wifiplanner.consent";      /* "granted" | "denied" */
const GA_ID = "G-6L5D662TQE";

function read(){
  try{
    return localStorage.getItem(KEY);
  }catch{
    return null;                        /* private mode, or storage blocked */
  }
}

function write(v){
  try{
    localStorage.setItem(KEY, v);
  }catch{
    /* nothing to do: the banner will simply ask again next visit */
  }
}

let loaded = false;
function loadAnalytics(){
  if(loaded){
    return;
  }
  loaded = true;
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag(){
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID);
}

let bar = null;

function dismiss(){
  if(bar){
    bar.remove();
    bar = null;
  }
}

function show(){
  if(bar){
    return;
  }
  bar = document.createElement("div");
  bar.className = "cbar";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", "Cookie choice");
  bar.innerHTML =
    '<p>This site uses Google Analytics to count visits, which needs cookies. ' +
    'Floor plans you open never leave your browser either way. ' +
    '<a href="terms.html">Terms of use</a></p>' +
    '<div class="cbtns">' +
      '<button class="btn" data-c="denied">Decline</button>' +
      '<button class="btn primary" data-c="granted">Accept</button>' +
    '</div>';
  bar.addEventListener("click", e => {
    const b = e.target.closest("button[data-c]");
    if(!b){
      return;
    }
    const v = b.dataset.c;
    write(v);
    if(v === "granted"){
      loadAnalytics();
    }
    dismiss();
  });
  document.body.appendChild(bar);
}

window.wpConsent = {
  reopen(){
    try{
      localStorage.removeItem(KEY);
    }catch{
      /* ignore — the banner still opens for this visit */
    }
    show();
  }
};

function start(){
  const b = document.getElementById("cookieBtn");
  if(b){
    b.addEventListener("click", () => window.wpConsent.reopen());
  }
  const choice = read();
  if(choice === "granted"){
    loadAnalytics();
  } else if(choice !== "denied"){
    show();
  }
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", start, {once:true});
} else {
  start();
}

})();

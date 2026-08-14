var he=globalThis,ue=he.ShadowRoot&&(he.ShadyCSS===void 0||he.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,be=Symbol(),Ye=new WeakMap,ee=class{constructor(e,t,n){if(this._$cssResult$=!0,n!==be)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o,t=this.t;if(ue&&e===void 0){let n=t!==void 0&&t.length===1;n&&(e=Ye.get(t)),e===void 0&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),n&&Ye.set(t,e))}return e}toString(){return this.cssText}},qe=i=>new ee(typeof i=="string"?i:i+"",void 0,be),U=(i,...e)=>{let t=i.length===1?i[0]:e.reduce((n,r,s)=>n+(a=>{if(a._$cssResult$===!0)return a.cssText;if(typeof a=="number")return a;throw Error("Value passed to 'css' function must be a 'css' function result: "+a+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(r)+i[s+1],i[0]);return new ee(t,i,be)},We=(i,e)=>{if(ue)i.adoptedStyleSheets=e.map(t=>t instanceof CSSStyleSheet?t:t.styleSheet);else for(let t of e){let n=document.createElement("style"),r=he.litNonce;r!==void 0&&n.setAttribute("nonce",r),n.textContent=t.cssText,i.appendChild(n)}},we=ue?i=>i:i=>i instanceof CSSStyleSheet?(e=>{let t="";for(let n of e.cssRules)t+=n.cssText;return qe(t)})(i):i;var{is:Pt,defineProperty:Tt,getOwnPropertyDescriptor:Mt,getOwnPropertyNames:Nt,getOwnPropertySymbols:jt,getPrototypeOf:_t}=Object,me=globalThis,Ve=me.trustedTypes,Ct=Ve?Ve.emptyScript:"",It=me.reactiveElementPolyfillSupport,te=(i,e)=>i,ke={toAttribute(i,e){switch(e){case Boolean:i=i?Ct:null;break;case Object:case Array:i=i==null?i:JSON.stringify(i)}return i},fromAttribute(i,e){let t=i;switch(e){case Boolean:t=i!==null;break;case Number:t=i===null?null:Number(i);break;case Object:case Array:try{t=JSON.parse(i)}catch{t=null}}return t}},Je=(i,e)=>!Pt(i,e),Xe={attribute:!0,type:String,converter:ke,reflect:!1,useDefault:!1,hasChanged:Je};Symbol.metadata??=Symbol("metadata"),me.litPropertyMetadata??=new WeakMap;var O=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=Xe){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let n=Symbol(),r=this.getPropertyDescriptor(e,n,t);r!==void 0&&Tt(this.prototype,e,r)}}static getPropertyDescriptor(e,t,n){let{get:r,set:s}=Mt(this.prototype,e)??{get(){return this[t]},set(a){this[t]=a}};return{get:r,set(a){let o=r?.call(this);s?.call(this,a),this.requestUpdate(e,o,n)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??Xe}static _$Ei(){if(this.hasOwnProperty(te("elementProperties")))return;let e=_t(this);e.finalize(),e.l!==void 0&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(te("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(te("properties"))){let t=this.properties,n=[...Nt(t),...jt(t)];for(let r of n)this.createProperty(r,t[r])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[n,r]of t)this.elementProperties.set(n,r)}this._$Eh=new Map;for(let[t,n]of this.elementProperties){let r=this._$Eu(t,n);r!==void 0&&this._$Eh.set(r,t)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let n=new Set(e.flat(1/0).reverse());for(let r of n)t.unshift(we(r))}else e!==void 0&&t.push(we(e));return t}static _$Eu(e,t){let n=t.attribute;return n===!1?void 0:typeof n=="string"?n:typeof e=="string"?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){let e=new Map,t=this.constructor.elementProperties;for(let n of t.keys())this.hasOwnProperty(n)&&(e.set(n,this[n]),delete this[n]);e.size>0&&(this._$Ep=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return We(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,n){this._$AK(e,n)}_$ET(e,t){let n=this.constructor.elementProperties.get(e),r=this.constructor._$Eu(e,n);if(r!==void 0&&n.reflect===!0){let s=(n.converter?.toAttribute!==void 0?n.converter:ke).toAttribute(t,n.type);this._$Em=e,s==null?this.removeAttribute(r):this.setAttribute(r,s),this._$Em=null}}_$AK(e,t){let n=this.constructor,r=n._$Eh.get(e);if(r!==void 0&&this._$Em!==r){let s=n.getPropertyOptions(r),a=typeof s.converter=="function"?{fromAttribute:s.converter}:s.converter?.fromAttribute!==void 0?s.converter:ke;this._$Em=r;let o=a.fromAttribute(t,s.type);this[r]=o??this._$Ej?.get(r)??o,this._$Em=null}}requestUpdate(e,t,n,r=!1,s){if(e!==void 0){let a=this.constructor;if(r===!1&&(s=this[e]),n??=a.getPropertyOptions(e),!((n.hasChanged??Je)(s,t)||n.useDefault&&n.reflect&&s===this._$Ej?.get(e)&&!this.hasAttribute(a._$Eu(e,n))))return;this.C(e,t,n)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(e,t,{useDefault:n,reflect:r,wrapped:s},a){n&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,a??t??this[e]),s!==!0||a!==void 0)||(this._$AL.has(e)||(this.hasUpdated||n||(t=void 0),this._$AL.set(e,t)),r===!0&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(t){Promise.reject(t)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[r,s]of this._$Ep)this[r]=s;this._$Ep=void 0}let n=this.constructor.elementProperties;if(n.size>0)for(let[r,s]of n){let{wrapped:a}=s,o=this[r];a!==!0||this._$AL.has(r)||o===void 0||this.C(r,void 0,s,o)}}let e=!1,t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(n=>n.hostUpdate?.()),this.update(t)):this._$EM()}catch(n){throw e=!1,this._$EM(),n}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(t=>t.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(t=>this._$ET(t,this[t])),this._$EM()}updated(e){}firstUpdated(e){}};O.elementStyles=[],O.shadowRootOptions={mode:"open"},O[te("elementProperties")]=new Map,O[te("finalized")]=new Map,It?.({ReactiveElement:O}),(me.reactiveElementVersions??=[]).push("2.1.2");var Te=globalThis,Ke=i=>i,fe=Te.trustedTypes,Ze=fe?fe.createPolicy("lit-html",{createHTML:i=>i}):void 0,it="$lit$",z=`lit$${Math.random().toFixed(9).slice(2)}$`,st="?"+z,Ht=`<${st}>`,Y=document,re=()=>Y.createComment(""),ie=i=>i===null||typeof i!="object"&&typeof i!="function",Me=Array.isArray,Rt=i=>Me(i)||typeof i?.[Symbol.iterator]=="function",$e=`[ 	
\f\r]`,ne=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Qe=/-->/g,et=/>/g,F=RegExp(`>|${$e}(?:([^\\s"'>=/]+)(${$e}*=${$e}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),tt=/'/g,nt=/"/g,ot=/^(?:script|style|textarea|title)$/i,Ne=i=>(e,...t)=>({_$litType$:i,strings:e,values:t}),$=Ne(1),nn=Ne(2),rn=Ne(3),q=Symbol.for("lit-noChange"),L=Symbol.for("lit-nothing"),rt=new WeakMap,B=Y.createTreeWalker(Y,129);function at(i,e){if(!Me(i)||!i.hasOwnProperty("raw"))throw Error("invalid template strings array");return Ze!==void 0?Ze.createHTML(e):e}var Ut=(i,e)=>{let t=i.length-1,n=[],r,s=e===2?"<svg>":e===3?"<math>":"",a=ne;for(let o=0;o<t;o++){let l=i[o],c,d,p=-1,h=0;for(;h<l.length&&(a.lastIndex=h,d=a.exec(l),d!==null);)h=a.lastIndex,a===ne?d[1]==="!--"?a=Qe:d[1]!==void 0?a=et:d[2]!==void 0?(ot.test(d[2])&&(r=RegExp("</"+d[2],"g")),a=F):d[3]!==void 0&&(a=F):a===F?d[0]===">"?(a=r??ne,p=-1):d[1]===void 0?p=-2:(p=a.lastIndex-d[2].length,c=d[1],a=d[3]===void 0?F:d[3]==='"'?nt:tt):a===nt||a===tt?a=F:a===Qe||a===et?a=ne:(a=F,r=void 0);let m=a===F&&i[o+1].startsWith("/>")?" ":"";s+=a===ne?l+Ht:p>=0?(n.push(c),l.slice(0,p)+it+l.slice(p)+z+m):l+z+(p===-2?o:m)}return[at(i,s+(i[t]||"<?>")+(e===2?"</svg>":e===3?"</math>":"")),n]},se=class i{constructor({strings:e,_$litType$:t},n){let r;this.parts=[];let s=0,a=0,o=e.length-1,l=this.parts,[c,d]=Ut(e,t);if(this.el=i.createElement(c,n),B.currentNode=this.el.content,t===2||t===3){let p=this.el.content.firstChild;p.replaceWith(...p.childNodes)}for(;(r=B.nextNode())!==null&&l.length<o;){if(r.nodeType===1){if(r.hasAttributes())for(let p of r.getAttributeNames())if(p.endsWith(it)){let h=d[a++],m=r.getAttribute(p).split(z),b=/([.?@])?(.*)/.exec(h);l.push({type:1,index:s,name:b[2],strings:m,ctor:b[1]==="."?Ae:b[1]==="?"?Se:b[1]==="@"?Le:V}),r.removeAttribute(p)}else p.startsWith(z)&&(l.push({type:6,index:s}),r.removeAttribute(p));if(ot.test(r.tagName)){let p=r.textContent.split(z),h=p.length-1;if(h>0){r.textContent=fe?fe.emptyScript:"";for(let m=0;m<h;m++)r.append(p[m],re()),B.nextNode(),l.push({type:2,index:++s});r.append(p[h],re())}}}else if(r.nodeType===8)if(r.data===st)l.push({type:2,index:s});else{let p=-1;for(;(p=r.data.indexOf(z,p+1))!==-1;)l.push({type:7,index:s}),p+=z.length-1}s++}}static createElement(e,t){let n=Y.createElement("template");return n.innerHTML=e,n}};function W(i,e,t=i,n){if(e===q)return e;let r=n!==void 0?t._$Co?.[n]:t._$Cl,s=ie(e)?void 0:e._$litDirective$;return r?.constructor!==s&&(r?._$AO?.(!1),s===void 0?r=void 0:(r=new s(i),r._$AT(i,t,n)),n!==void 0?(t._$Co??=[])[n]=r:t._$Cl=r),r!==void 0&&(e=W(i,r._$AS(i,e.values),r,n)),e}var Ee=class{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){let{el:{content:t},parts:n}=this._$AD,r=(e?.creationScope??Y).importNode(t,!0);B.currentNode=r;let s=B.nextNode(),a=0,o=0,l=n[0];for(;l!==void 0;){if(a===l.index){let c;l.type===2?c=new oe(s,s.nextSibling,this,e):l.type===1?c=new l.ctor(s,l.name,l.strings,this,e):l.type===6&&(c=new Pe(s,this,e)),this._$AV.push(c),l=n[++o]}a!==l?.index&&(s=B.nextNode(),a++)}return B.currentNode=Y,r}p(e){let t=0;for(let n of this._$AV)n!==void 0&&(n.strings!==void 0?(n._$AI(e,n,t),t+=n.strings.length-2):n._$AI(e[t])),t++}},oe=class i{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,n,r){this.type=2,this._$AH=L,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=n,this.options=r,this._$Cv=r?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode,t=this._$AM;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=W(this,e,t),ie(e)?e===L||e==null||e===""?(this._$AH!==L&&this._$AR(),this._$AH=L):e!==this._$AH&&e!==q&&this._(e):e._$litType$!==void 0?this.$(e):e.nodeType!==void 0?this.T(e):Rt(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==L&&ie(this._$AH)?this._$AA.nextSibling.data=e:this.T(Y.createTextNode(e)),this._$AH=e}$(e){let{values:t,_$litType$:n}=e,r=typeof n=="number"?this._$AC(e):(n.el===void 0&&(n.el=se.createElement(at(n.h,n.h[0]),this.options)),n);if(this._$AH?._$AD===r)this._$AH.p(t);else{let s=new Ee(r,this),a=s.u(this.options);s.p(t),this.T(a),this._$AH=s}}_$AC(e){let t=rt.get(e.strings);return t===void 0&&rt.set(e.strings,t=new se(e)),t}k(e){Me(this._$AH)||(this._$AH=[],this._$AR());let t=this._$AH,n,r=0;for(let s of e)r===t.length?t.push(n=new i(this.O(re()),this.O(re()),this,this.options)):n=t[r],n._$AI(s),r++;r<t.length&&(this._$AR(n&&n._$AB.nextSibling,r),t.length=r)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){let n=Ke(e).nextSibling;Ke(e).remove(),e=n}}setConnected(e){this._$AM===void 0&&(this._$Cv=e,this._$AP?.(e))}},V=class{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,n,r,s){this.type=1,this._$AH=L,this._$AN=void 0,this.element=e,this.name=t,this._$AM=r,this.options=s,n.length>2||n[0]!==""||n[1]!==""?(this._$AH=Array(n.length-1).fill(new String),this.strings=n):this._$AH=L}_$AI(e,t=this,n,r){let s=this.strings,a=!1;if(s===void 0)e=W(this,e,t,0),a=!ie(e)||e!==this._$AH&&e!==q,a&&(this._$AH=e);else{let o=e,l,c;for(e=s[0],l=0;l<s.length-1;l++)c=W(this,o[n+l],t,l),c===q&&(c=this._$AH[l]),a||=!ie(c)||c!==this._$AH[l],c===L?e=L:e!==L&&(e+=(c??"")+s[l+1]),this._$AH[l]=c}a&&!r&&this.j(e)}j(e){e===L?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}},Ae=class extends V{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===L?void 0:e}},Se=class extends V{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==L)}},Le=class extends V{constructor(e,t,n,r,s){super(e,t,n,r,s),this.type=5}_$AI(e,t=this){if((e=W(this,e,t,0)??L)===q)return;let n=this._$AH,r=e===L&&n!==L||e.capture!==n.capture||e.once!==n.once||e.passive!==n.passive,s=e!==L&&(n===L||r);r&&this.element.removeEventListener(this.name,this,n),s&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}},Pe=class{constructor(e,t,n){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=n}get _$AU(){return this._$AM._$AU}_$AI(e){W(this,e)}};var Ot=Te.litHtmlPolyfillSupport;Ot?.(se,oe),(Te.litHtmlVersions??=[]).push("3.3.3");var lt=(i,e,t)=>{let n=t?.renderBefore??e,r=n._$litPart$;if(r===void 0){let s=t?.renderBefore??null;n._$litPart$=r=new oe(e.insertBefore(re(),s),s,void 0,t??{})}return r._$AI(i),r};var je=globalThis,C=class extends O{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=lt(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return q}};C._$litElement$=!0,C.finalized=!0,je.litElementHydrateSupport?.({LitElement:C});var zt=je.litElementPolyfillSupport;zt?.({LitElement:C});(je.litElementVersions??=[]).push("4.2.2");var dt="peak-theme",ct="peak-ui-tokens",Gt=`
:root {
  --bg: #f5f6fa;
  --panel: #ffffff;
  --panel-2: #f8f9fd;
  --ink: #161d2e;
  --ink-2: #3b465d;
  --muted: #68738b;
  --faint: #98a2b8;
  --line: #e2e6f0;
  --line-2: #edf0f7;
  --accent: #4f46e5;
  --accent-2: #7c3aed;
  --accent-ink: #4338ca;
  --accent-soft: #eef0ff;
  --accent-line: #cfd4ff;
  --teal: #0d9488;
  --teal-soft: #e4f7f3;
  --amber: #b45309;
  --amber-soft: #fbf0dd;
  --rose: #be123c;
  --rose-soft: #fdebee;
  --canvas: #fafbfe;
  --canvas-dot: #dfe4ef;
  --glass: rgba(255, 255, 255, 0.82);
  --shadow-sm: 0 1px 2px rgb(16 24 40 / 0.05);
  --shadow-md: 0 8px 24px rgb(30 41 59 / 0.08);
  --shadow-lg: 0 18px 46px rgb(30 41 59 / 0.15);
  --radius: 12px;
  --radius-lg: 16px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
:root.dark {
  --bg: #0a0d16;
  --panel: #121624;
  --panel-2: #161b2c;
  --ink: #e7eaf3;
  --ink-2: #c3c9da;
  --muted: #8d96ad;
  --faint: #5d667d;
  --line: #232a3e;
  --line-2: #1b2133;
  --accent: #818cf8;
  --accent-2: #a78bfa;
  --accent-ink: #a5b4fc;
  --accent-soft: #1a2038;
  --accent-line: #2e3760;
  --teal: #2dd4bf;
  --teal-soft: #0e2a27;
  --amber: #f0b45c;
  --amber-soft: #2c2113;
  --rose: #fb7185;
  --rose-soft: #2c1218;
  --canvas: #0d1019;
  --canvas-dot: #1b2133;
  --glass: rgba(13, 16, 25, 0.78);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.35);
  --shadow-md: 0 8px 24px rgb(0 0 0 / 0.4);
  --shadow-lg: 0 18px 46px rgb(0 0 0 / 0.55);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI",
    Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  transition: background-color 0.25s ease, color 0.25s ease;
}
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: var(--accent); }
::selection { background: color-mix(in srgb, var(--accent) 24%, transparent); }

/* Touch: kill double-tap zoom delay + iOS highlight flash on interactive elements. */
button, a, select, [role="button"] {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`;function ae(){return document.documentElement.classList.contains("dark")}function pt(){if(!document.getElementById(ct)){let t=document.createElement("style");t.id=ct,t.textContent=Gt,document.head.append(t)}let i=localStorage.getItem(dt),e=i?i==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",e)}function X(){let i=!ae();document.documentElement.classList.toggle("dark",i),localStorage.setItem(dt,i?"dark":"light")}var J=U`
  :host { display: block; }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--panel);
    padding: 7px 11px;
    font-size: 12px;
    font-weight: 650;
    color: var(--ink-2);
    text-decoration: none;
    box-shadow: var(--shadow-sm);
    transition: background-color 0.15s ease, border-color 0.15s ease,
      transform 0.12s ease, box-shadow 0.15s ease;
    white-space: nowrap;
  }
  .btn:hover { background: var(--panel-2); border-color: var(--faint); }
  .btn:active { transform: translateY(1px) scale(0.985); }
  .btn.primary {
    color: var(--accent-ink);
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }
  .btn.primary:hover { border-color: var(--accent); }
  .btn.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 35%, var(--line)); background: var(--amber-soft); }
  .btn.danger { color: var(--rose); border-color: color-mix(in srgb, var(--rose) 32%, var(--line)); background: var(--rose-soft); }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
  .icon-btn { width: 32px; height: 32px; padding: 0; justify-content: center; }
  /* Enlarge touch targets on coarse pointers (phones / tablets). */
  @media (pointer: coarse) {
    .btn { min-height: 40px; padding: 9px 14px; }
    .icon-btn { width: 40px; height: 40px; }
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    background: var(--panel-2);
    color: var(--muted);
    border: 1px solid var(--line-2);
    white-space: nowrap;
  }
  .status::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
  .status.active { background: var(--teal-soft); color: var(--teal); border-color: transparent; }
  .status.stopped { background: var(--amber-soft); color: var(--amber); border-color: transparent; }
  .status.completed { background: var(--panel-2); color: var(--faint); }
  .status.active::before,
  .status.running::before {
    animation: peak-pulse 1.6s ease-in-out infinite;
  }
  @keyframes peak-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; }
    50% { opacity: 0.55; box-shadow: 0 0 0 4px transparent; }
  }

  .message {
    color: var(--muted);
    padding: 26px 18px;
    text-align: center;
    font-size: 12.5px;
  }
  .message strong { display: block; margin-bottom: 5px; color: var(--ink-2); font-size: 15px; font-weight: 680; }
  .message.error { color: var(--rose); }
  .message.error strong { color: var(--rose); }

  .hidden { display: none !important; }
`;async function j(i,e={}){let t=new Headers(e.headers??{});e.body!==void 0&&!t.has("content-type")&&t.set("content-type","application/json");let n=await fetch(i,{method:e.method,headers:t,body:e.body!==void 0?JSON.stringify(e.body):void 0}),r=await n.text();if(!n.ok){let a=r;try{a=JSON.parse(r).error??r}catch{}throw new Error(a||`HTTP ${n.status}`)}return n.status===204||!r?null:(n.headers.get("content-type")??"").includes("json")?JSON.parse(r):r}var Dt=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})$/;function G(i){if(!i)return"\u2014";let e=Dt.exec(i),t=e?new Date(Number(e[1]),Number(e[2])-1,Number(e[3]),Number(e[4]),Number(e[5]),Number(e[6]),Number(e[7])):new Date(i);return Number.isNaN(t.valueOf())?i:new Intl.DateTimeFormat(void 0,{dateStyle:"medium",timeStyle:"short"}).format(t)}function ht(i){return i<1024?`${i} B`:i<1048576?`${(i/1024).toFixed(1)} KiB`:`${(i/1048576).toFixed(1)} MiB`}function ut(i,e){return i===e?"current":i.slice(0,8)}function H(i){let e=document.createElement("span");return e.textContent=String(i),e.innerHTML}function E(i){return`${i.projectId}:${i.id}`}function xt(i){let e=i.lastIndexOf(":");return[i.slice(0,e),i.slice(e+1)]}var vt="v6",Ie=i=>`peak-graph-layout:${vt}:${i}`,He=i=>`peak-intent-layout:${vt}:${i}`;function yt(i){try{return JSON.parse(localStorage.getItem(Ie(i))??"{}")}catch{return{}}}function bt(i){try{return JSON.parse(localStorage.getItem(He(i))??"{}")}catch{return{}}}function wt(i,e){let t=yt(i);t[e.key]={x:e.x,y:e.y};try{localStorage.setItem(Ie(i),JSON.stringify(t))}catch{}}function kt(i,e){let t=bt(i);t[e.id]={x:Math.round(e.handle.x),y:Math.round(e.handle.y)};try{localStorage.setItem(He(i),JSON.stringify(t))}catch{}}function $t(i){localStorage.removeItem(Ie(i)),localStorage.removeItem(He(i))}function Et(i,e){let l=new Map,c=new Map;for(let u of i.intents)for(let x of u.from){if(x.projectId===i.project.id)continue;let y=E(x),k=c.get(y);(!k||u.createdAt<k)&&c.set(y,u.createdAt)}let d=i.intents.find(u=>u.to?.id==="goal");for(let u of i.facts){let x=`${i.project.id}:${u.id}`,y=u.id==="goal"?d?.concludedAt??d?.createdAt??"99999999999999.999":u.createdAt;l.set(x,{key:x,type:"fact",id:u.id,description:u.description,record:u,eventAt:y,depth:u.id==="origin"?0:1,x:0,y:0,w:238,h:104})}for(let u of i.intents)for(let x of u.from){let y=E(x);if(l.has(y))continue;let k=e.get(y),M=c.get(y)??u.createdAt,T=k?.createdAt,Z=T?T>i.project.createdAt?T:i.project.createdAt:M;l.set(y,{key:y,type:"external",id:x.id,projectId:x.projectId,description:x.description,record:k??x,eventAt:Z,introducedAt:M,depth:0,x:0,y:0,w:238,h:104})}for(let u=0;u<i.intents.length+2;u++)for(let x of i.intents){if(!x.to)continue;let y=l.get(E(x.to));if(!y)continue;let k=Math.max(...x.from.map(M=>l.get(E(M))?.depth??0));y.depth=Math.max(y.depth,k+1)}for(let u of l.values()){if(u.type!=="external")continue;let x=0;for(let y of i.intents)if(y.from.some(k=>E(k)===u.key))for(let k of y.from){let M=l.get(E(k));M&&M!==u&&(x=Math.max(x,M.depth))}u.depth=x}for(let u=0;u<i.intents.length+2;u++)for(let x of i.intents){if(!x.to)continue;let y=l.get(E(x.to));y&&(y.depth=Math.max(y.depth,Math.max(...x.from.map(k=>l.get(E(k))?.depth??0))+1))}let p=Math.max(0,...[...l.values()].map(u=>u.depth)),h=l.get(`${i.project.id}:goal`);h&&!d&&(h.depth=p+1,p=h.depth);let m=new Map;for(let u of l.values()){let x=m.get(u.depth)??[];x.push(u),m.set(u.depth,x)}for(let u of m.values())u.sort((x,y)=>K(x)-K(y)||x.eventAt.localeCompare(y.eventAt)||x.id.localeCompare(y.id));let b=Ft(m,i,l,p),f=Math.max(1,...[...m.values()].map(u=>u.length)),v=f*104+(f-1)*46;for(let u of m.values()){let x=u.length*104+(u.length-1)*46,y=78+(v-x)/2;u.forEach((k,M)=>{k.y=y+M*150})}Bt(m,b,78,v,104,46,p);let g=[...l.values()].sort((u,x)=>u.depth-x.depth||u.y-x.y||K(u)-K(x)||u.id.localeCompare(x.id));for(let u of g)u.x=82+u.depth*364;let S=yt(i.project.id),w=[];for(let u of g){let x=S[u.key];if(x&&Number.isFinite(x.x)&&Number.isFinite(x.y))u.x=x.x,u.y=x.y;else{let y=gt(u,u.x,u.y,w);u.x=y.x,u.y=y.y}w.push(u)}let A=Math.max(320,...g.map(u=>u.x+u.w)),P=Math.max(720,A+180)+82,I=[...g],_=null,N=Math.max(78+v,...g.map(u=>u.y+u.h))+82,ye=i.hints;if(ye.length){let k=Math.max(1,Math.floor((P-164+26)/244)),M=Math.ceil(ye.length/k);_=N+55,ye.forEach((T,Z)=>{let R={key:`hint:${T.id}`,type:"hint",id:T.id,description:T.content,record:T,eventAt:T.createdAt,depth:p+1,x:82+Z%k*244,y:_+Math.floor(Z/k)*110,w:218,h:84,hintIndex:Z},Q=S[R.key];if(Q&&Number.isFinite(Q.x)&&Number.isFinite(Q.y))R.x=Q.x,R.y=Q.y;else{let Be=gt(R,R.x,R.y,I);R.x=Be.x,R.y=Be.y}I.push(R)}),N=Math.max(_+M*84+(M-1)*26+82,...I.map(T=>T.y+T.h+82))}let pe=[];for(let u of i.intents){let x=u.from.map(T=>l.get(E(T))).filter(T=>!!T);if(!x.length)continue;let y=u.to?l.get(E(u.to)):null;if(u.to&&!y)continue;let k=!u.to,M=k&&(u.customProfile!==null||u.customProfileDigest!==null);pe.push({id:u.id,record:u,sources:x,target:y??null,open:k,profiled:M,handle:{x:0,y:0},manual:!1})}Yt(pe,I,i.project.id);let Lt=Math.max(0,...pe.map(u=>xe(u).x));return{nodes:I,edges:pe,width:Math.max(P,Lt+82),height:N,hintTop:_,pad:82}}function Ft(i,e,t,n){let r=(a,o)=>K(a)-K(o)||a.eventAt.localeCompare(o.eventAt)||a.id.localeCompare(o.id),s=new Map;for(let a of t.values())s.set(a.key,[]);for(let a of e.intents){if(!a.to)continue;let o=t.get(E(a.to));if(o)for(let l of a.from){let c=t.get(E(l));c&&(s.get(o.key).push(c),s.get(c.key).push(o))}}for(let a=0;a<8;a++){let o=a%2?[...Array(n+1).keys()].reverse():[...Array(n+1).keys()];for(let l of o){let c=i.get(l);if(!c||c.length<2)continue;let d=new Map(c.map((p,h)=>[p.key,h]));c.sort((p,h)=>{let m=b=>{let f=(s.get(b.key)??[]).filter(v=>a%2?v.depth>l:v.depth<l).map(v=>(i.get(v.depth)??[]).indexOf(v));return f.length?f.reduce((v,g)=>v+g,0)/f.length:d.get(b.key)};return m(p)-m(h)||r(p,h)})}}return s}function Bt(i,e,t,n,r,s,a){for(let o=0;o<4;o++){let l=o%2?[...Array(a+1).keys()].reverse():[...Array(a+1).keys()];for(let c of l){let d=i.get(c);if(!d?.length)continue;for(let m of d){let b=e.get(m.key)??[];if(b.length){let f=b.reduce((v,g)=>v+g.y+g.h/2,0)/b.length-r/2;m.y=m.y*.68+f*.32}}d.sort((m,b)=>m.y-b.y||m.id.localeCompare(b.id));for(let m=1;m<d.length;m++)d[m].y=Math.max(d[m].y,d[m-1].y+r+s);for(let m=d.length-2;m>=0;m--)d[m].y=Math.min(d[m].y,d[m+1].y-r-s);let p=(d[0].y+d[d.length-1].y+r)/2,h=t+n/2-p;for(let m of d)m.y+=h}}}function Re(i){return i.profiled?`${i.id} \xB7 OPEN \xB7 PROFILE`:i.open?`${i.id} \xB7 OPEN`:i.id}function Ue(i){return Math.max(38,Re(i).length*6.2+16)}function Oe(i,e){let t=new Set([e]),n=new Set,r=[e];for(let s=0;s<r.length;s++){let a=r[s];for(let o of i.intents){let l=o.to!==null&&E(o.to)===a,c=o.from.some(p=>E(p)===a);if(!l&&!c)continue;n.add(o.id);let d=o.from.map(E);o.to&&d.push(E(o.to));for(let p of d)t.has(p)||(t.add(p),r.push(p))}}return{nodes:t,edges:n}}function Yt(i,e,t){let n=bt(t),r=[];for(let s of i){let a=s.sources.map(D),o={x:a.reduce((p,h)=>p+h.x,0)/a.length,y:a.reduce((p,h)=>p+h.y,0)/a.length},l=s.target?D(s.target):{x:Math.max(...s.sources.map(p=>p.x+p.w))+150,y:o.y},c={x:(o.x+l.x)/2,y:(o.y+l.y)/2};s.open&&(c.x=l.x,c.y=l.y);let d=n[s.id];if(d&&Number.isFinite(d.x)&&Number.isFinite(d.y))s.handle=ge(s,d.x,d.y,e,r),s.manual=!0;else{let p=[c,{x:c.x,y:o.y},{x:c.x,y:l.y}];for(let m=1;m<=5;m++)p.push({x:c.x,y:c.y+m*58},{x:c.x,y:c.y-m*58});let h=null;for(let m of p){if(Ce(s,m.x,m.y,e,r))continue;let b=qt(s,m,e,r)+Math.abs(m.y-c.y)*.015;(!h||b<h.score)&&(h={...m,score:b})}s.handle=h?{x:h.x,y:h.y}:ge(s,c.x,c.y,e,r)}r.push(s)}}function mt(i,e=i.handle){let t=i.target?D(i.target):e,n=[];for(let r of i.sources)n.push([D(r),e]),i.target&&n.push([e,t]);return n}function qt(i,e,t,n){let r=new Set([...i.sources,i.target].filter(Boolean)),s=mt(i,e),a=0;for(let[o,l]of s)for(let c of t)c.type==="hint"||r.has(c)||Wt(o,l,{x:c.x-10,y:c.y-10,w:c.w+20,h:c.h+20})&&(a+=80);for(let o of n)for(let l of s)for(let c of mt(o))ce(...l,...c)&&(a+=24);return a}function Wt(i,e,t){if(i.x>=t.x&&i.x<=t.x+t.w&&i.y>=t.y&&i.y<=t.y+t.h||e.x>=t.x&&e.x<=t.x+t.w&&e.y>=t.y&&e.y<=t.y+t.h)return!0;let n={x:t.x,y:t.y},r={x:t.x+t.w,y:t.y},s={x:t.x+t.w,y:t.y+t.h},a={x:t.x,y:t.y+t.h};return ce(i,e,n,r)||ce(i,e,r,s)||ce(i,e,s,a)||ce(i,e,a,n)}function ce(i,e,t,n){let r=(c,d,p)=>(d.x-c.x)*(p.y-c.y)-(d.y-c.y)*(p.x-c.x),s=r(i,e,t),a=r(i,e,n),o=r(t,n,i),l=r(t,n,e);return s*a<0&&o*l<0}function xe(i){return i.open?i.handle:D(i.target)}function ft(i,e=i.handle.x,t=i.handle.y){let n=Ue(i)+20;return{x:e-n/2,y:t-20,w:n,h:40}}function Ce(i,e,t,n,r){let s=ft(i,e,t);return n.some(a=>s.x<a.x+a.w+16&&s.x+s.w+16>a.x&&s.y<a.y+a.h+16&&s.y+s.h+16>a.y)?!0:r.some(a=>{let o=ft(a);return s.x<o.x+o.w+16&&s.x+s.w+16>o.x&&s.y<o.y+o.h+16&&s.y+s.h+16>o.y})}function ge(i,e,t,n,r,s=null){if(!Ce(i,e,t,n,r))return{x:e,y:t};let a=[Math.PI/2,-Math.PI/2,0,Math.PI,Math.PI/4,-Math.PI/4,3*Math.PI/4,-3*Math.PI/4];for(let o=1;o<20;o++)for(let l of a){let c={x:e+Math.cos(l)*o*28,y:t+Math.sin(l)*o*28};if(!Ce(i,c.x,c.y,n,r))return c}return s??{x:e,y:t}}function le(i,e,t,n){return e<n.x+n.w+24&&e+i.w+24>n.x&&t<n.y+n.h+24&&t+i.h+24>n.y}function gt(i,e,t,n,r=null){let s=n.filter(c=>c!==i),a=e,o=t;for(let c=0;c<Math.max(4,s.length*3);c++){let d=s.filter(h=>le(i,a,o,h));if(!d.length)return{x:a,y:o};let p=[];for(let h of d)p.push({x:h.x-24-i.w,y:o},{x:h.x+h.w+24,y:o},{x:a,y:h.y-24-i.h},{x:a,y:h.y+h.h+24});if(p.sort((h,m)=>{let b=s.reduce((v,g)=>v+(le(i,h.x,h.y,g)?1:0),0),f=s.reduce((v,g)=>v+(le(i,m.x,m.y,g)?1:0),0);return b-f||Math.hypot(h.x-e,h.y-t)-Math.hypot(m.x-e,m.y-t)}),!p.length)break;a=p[0].x,o=p[0].y}if(r)return r;let l=0;for(;s.some(c=>le(i,a,o,c))&&l++<s.length+2;){let c=s.filter(d=>le(i,a,o,d));o=Math.max(...c.map(d=>d.y+d.h+24))}return{x:a,y:o}}function D(i){return{x:i.x+i.w/2,y:i.y+i.h/2}}function ve(i,e){let t=D(i),n=e.x-t.x,r=e.y-t.y;if(!n&&!r)return t;let s=1/Math.max(Math.abs(n)/(i.w/2),Math.abs(r)/(i.h/2));return{x:t.x+n*s,y:t.y+r*s}}function de(i,e){let t=e.x-i.x,n=e.y-i.y;if(Math.abs(t)>=Math.abs(n)){let a=Math.max(28,Math.min(96,Math.abs(t)*.38)),o=Math.sign(t)||1;return`M ${i.x} ${i.y} C ${i.x+a*o} ${i.y}, ${e.x-a*o} ${e.y}, ${e.x} ${e.y}`}let r=Math.max(28,Math.min(88,Math.abs(n)*.38)),s=Math.sign(n)||1;return`M ${i.x} ${i.y} C ${i.x} ${i.y+r*s}, ${e.x} ${e.y-r*s}, ${e.x} ${e.y}`}function K(i){return i.id==="origin"?-10:i.type==="external"?-5:i.id==="goal"?10:i.type==="hint"?20+(i.hintIndex??0):0}function ze(i,e){let t=/^i(\d+)$/.exec(i),r=(222+((t?Number(t[1]):[...i].reduce((o,l)=>o*33+(l.codePointAt(0)??0)>>>0,5381))-1)*47)%360,s=e?62:47,a=e?46:42;return`hsl(${r.toFixed(1)} ${a}% ${s}%)`}function At(i,e){return i.type==="hint"?e?{fill:"#2a2213",stroke:"#8a6324",accent:"#e3b04e"}:{fill:"#fffaf0",stroke:"#e5aa4d",accent:"#b87413"}:i.type==="external"?e?{fill:"#221c3d",stroke:"#6d4fd8",accent:"#a78bfa"}:{fill:"#ede9fe",stroke:"#7c3aed",accent:"#5b21b6"}:i.id==="origin"?e?{fill:"#0e2b26",stroke:"#2ba08c",accent:"#4cd4c0"}:{fill:"#effcf8",stroke:"#32a996",accent:"#087f72"}:i.id==="goal"?e?{fill:"#2c1218",stroke:"#c04f66",accent:"#f490a1"}:{fill:"#fff2f4",stroke:"#e27587",accent:"#bf3f56"}:e?{fill:"#1a1f33",stroke:"#5a5ec9",accent:"#9ba0f5"}:{fill:"#f5f6ff",stroke:"#7168d5",accent:"#5146bd"}}function _e(i){let e=0;for(let t of i){let n=t.codePointAt(0)??0;e+=n>=11904&&n<=40959||n>=12288||n>=65280&&n<=65519?12:t===" "?3.5:6.7}return e}function St(i,e,t){let n=[...String(i).replace(/\s+/g," ").trim()],r=[];for(;n.length&&r.length<t;){let s=0,a=0;for(;a<n.length;){let c=_e(n[a]);if(s+c>e)break;s+=c,a++}a===0&&(a=1);let o=a;if(o<n.length){let c=o;for(let d=o-1;d>=0;d--)if(n[d]===" "){c=d;break}c>o*.45&&(o=c)}let l=n.splice(0,o).join("").trim();for(;n[0]===" ";)n.shift();if(r.length===t-1&&n.length){let c="",d=0;for(let p of l){let h=_e(p);if(d+h>e-_e("\u2026"))break;c+=p,d+=h}l=c+"\u2026"}r.push(l)}return r.length?r:["\u2014"]}var Vt="http://www.w3.org/2000/svg",Xt=U`
  :host {
    display: block;
    height: 100vh;
    height: 100dvh;
  }
  .shell {
    height: 100vh;
    height: 100dvh;
    display: grid;
    grid-template-columns: 292px minmax(0, 1fr) 332px;
    grid-template-rows: 58px minmax(0, 1fr);
    background: var(--bg);
  }
  /* Top bar --------------------------------------------------------------- */
  .topbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 max(18px, env(safe-area-inset-right)) 0 max(18px, env(safe-area-inset-left));
    background: var(--glass);
    backdrop-filter: blur(14px) saturate(1.4);
    border-bottom: 1px solid var(--line);
    z-index: 5;
    animation: peak-bar-in 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes peak-bar-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-side-in-l { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes peak-side-in-r { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes peak-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes peak-card-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-pop-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 780;
    letter-spacing: -0.02em;
    font-size: 14.5px;
  }
  .logo {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-2));
    box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 38%, transparent);
  }
  .logo svg { width: 19px; }
  .project-heading { min-width: 0; display: flex; align-items: center; gap: 9px; }
  .project-heading strong { max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
  .spacer { flex: 1; }
  .toolbar { display: flex; align-items: center; gap: 7px; }
  .theme-toggle { font-size: 13px; }

  /* Sidebar ---------------------------------------------------------------- */
  .sidebar {
    min-height: 0;
    background: var(--panel);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    animation: peak-side-in-l 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .side-head {
    padding: 17px 16px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .eyebrow {
    font-size: 10px;
    color: var(--faint);
    font-weight: 750;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }
  .count-badge {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 10.5px;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }
  .project-list { overflow: auto; padding: 2px 10px 16px; }
  .project-card {
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    border-radius: 13px;
    padding: 12px;
    margin: 3px 0;
    color: var(--ink);
    transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .project-card:hover { background: var(--panel-2); }
  .project-card.active {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .project-card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .project-card-title .status { flex: none; }
  .project-line {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .project-line.goal { color: var(--muted); }
  .project-line b {
    flex: none;
    font-size: 8.5px;
    font-weight: 780;
    letter-spacing: 0.09em;
    color: var(--accent-ink);
  }
  .project-line.goal b { color: var(--faint); }
  .project-line span {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-card p { margin: 7px 0 0; color: var(--muted); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project-card.enter { animation: peak-card-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .project-card code {
    display: block;
    margin-top: 7px;
    color: var(--faint);
    font: 10px/1.3 var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty {
    padding: 42px 20px;
    text-align: center;
    color: var(--faint);
    font-size: 12.5px;
  }
  .empty strong { display: block; color: var(--ink-2); margin-bottom: 4px; font-size: 14px; }

  /* Workspace --------------------------------------------------------------- */
  .workspace {
    min-width: 0;
    min-height: 0;
    position: relative;
    overflow: hidden;
    background-color: var(--canvas);
    background-image:
      radial-gradient(circle at 18% 14%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 30%),
      radial-gradient(circle at 82% 76%, color-mix(in srgb, var(--accent-2) 8%, transparent), transparent 32%),
      radial-gradient(var(--canvas-dot) 1px, transparent 1px);
    background-size: auto, auto, 22px 22px;
    transition: background-color 0.25s ease;
    animation: peak-fade-in 0.5s ease both;
  }
  .canvas-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--faint);
    text-align: center;
    padding: 24px;
    font-size: 13px;
  }
  .canvas-empty strong { display: block; color: var(--ink-2); font-size: 16px; margin-bottom: 5px; }
  .canvas-empty .mark {
    width: 74px;
    height: 74px;
    margin: 0 auto 14px;
    border-radius: 22px;
    display: grid;
    place-items: center;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    box-shadow: var(--shadow-md);
  }
  .canvas-empty .mark svg { width: 36px; }
  .graph-tools {
    position: absolute;
    left: 14px;
    top: 14px;
    z-index: 3;
    display: flex;
    gap: 6px;
  }
  .graph-tools .btn {
    background: var(--glass);
    backdrop-filter: blur(8px);
    border-radius: 10px;
  }
  .legend {
    position: absolute;
    left: 14px;
    bottom: 14px;
    z-index: 3;
    display: flex;
    gap: 13px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    background: var(--glass);
    backdrop-filter: blur(8px);
    border-radius: 10px;
    color: var(--muted);
    font-size: 10px;
  }
  .legend span { display: flex; align-items: center; gap: 5px; }
  .dot { width: 8px; height: 8px; border-radius: 3px; background: var(--panel); border: 2px solid var(--accent); }
  .dot.external { border-color: var(--accent-2); background: color-mix(in srgb, var(--accent-2) 30%, var(--panel)); box-shadow: inset 3px 0 color-mix(in srgb, var(--accent-2) 80%, transparent); }
  .dot.intent {
    width: 18px;
    height: 8px;
    border: 0;
    border-radius: 0;
    background: linear-gradient(90deg, #7c3aed, #2563eb, #0891b2, #059669, #ca8a04, #ea580c, #e11d48);
    clip-path: polygon(0 35%, 76% 35%, 76% 0, 100% 50%, 76% 100%, 76% 65%, 0 65%);
    opacity: 0.85;
  }
  .dot.hint { border-color: #e9a23b; background: var(--amber-soft); }
  #viewport { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: grab; overscroll-behavior: none; }
  #viewport.dragging { cursor: grabbing; }
  #graph { width: 100%; height: 100%; display: block; }

  /* Graph inside the SVG ------------------------------------------------------ */
  .layout-label { font: 750 10px Inter, system-ui, sans-serif; letter-spacing: 0.14em; fill: var(--faint); }
  .layout-rule { stroke: var(--line); stroke-width: 1; stroke-dasharray: 4 7; }
  .graph-node { cursor: grab; touch-action: none; user-select: none; transition: opacity 0.22s ease, filter 0.22s ease; }
  .graph-node.dragging { cursor: grabbing; }
  .graph-node.context-dimmed { opacity: 0.16; filter: blur(1.7px) saturate(0.45); }
  .graph-node rect {
    filter: drop-shadow(0 5px 8px color-mix(in srgb, var(--ink) 9%, transparent));
    transition: stroke-width 0.15s, filter 0.15s;
  }
  .graph-node:hover rect,
  .graph-node.selected rect {
    stroke-width: 3;
    filter: drop-shadow(0 8px 12px color-mix(in srgb, var(--ink) 16%, transparent));
  }
  /* Selected Intent endpoints (from/to) glow in that Intent's own color. */
  .graph-node.intent-endpoint rect {
    stroke: var(--endpoint-color, var(--accent));
    stroke-width: 3;
    filter: drop-shadow(0 0 9px color-mix(in srgb, var(--endpoint-color, var(--accent)) 48%, transparent));
  }
  /* Facts inside the selected Fact's proof chain. */
  .graph-node.chain-focus rect {
    stroke-width: 3;
    filter: drop-shadow(0 0 10px color-mix(in srgb, var(--ink) 24%, transparent));
  }
  .node-id { font: 700 11px var(--mono); letter-spacing: 0.03em; }
  .node-type { font: 750 9px Inter, system-ui, sans-serif; letter-spacing: 0.11em; }
  .node-text { font: 12px Inter, system-ui, sans-serif; fill: var(--ink-2); }
  .intent-edge { transition: opacity 0.2s ease, filter 0.2s ease; }
  .intent-edge.context-dimmed { opacity: 0.1; filter: blur(1.2px); }
  .edge-casing, .edge, .edge-hit { vector-effect: non-scaling-stroke; }
  .edge-casing {
    fill: none;
    stroke: var(--canvas);
    stroke-width: calc(9px * var(--edge-scale, 1));
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .edge {
    fill: none;
    stroke: var(--edge-color);
    stroke-width: calc(2.6px * var(--edge-scale, 1));
    stroke-linecap: round;
    stroke-linejoin: round;
    marker-end: url(#arrow);
    filter: drop-shadow(0 1px 1px color-mix(in srgb, var(--edge-color) 22%, transparent));
    transition: stroke-width 0.16s, filter 0.16s;
  }
  .intent-edge:hover .edge {
    stroke-width: calc(3.4px * var(--edge-scale, 1));
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--edge-color) 46%, transparent));
  }
  .edge.branch { marker-end: none; stroke: color-mix(in srgb, var(--edge-color) 76%, #94a3b8); }
  /* Open Intents drift slowly: still waiting to be picked up. */
  .edge.open {
    stroke: var(--edge-color);
    stroke-dasharray: 8 6;
    marker-end: url(#arrow);
    opacity: 0.84;
    animation: peak-open-dash 2.6s linear infinite;
  }
  .edge.open.branch { marker-end: none; }
  /* Open Intents with a pinned custom execution profile: still open, but the
   * profile is fixed at creation — a calmer drift than a plain open Intent. */
  .edge.profiled {
    stroke: var(--edge-color);
    stroke-width: calc(3.4px * var(--edge-scale, 1));
    stroke-dasharray: 10 7;
    marker-end: url(#arrow);
    opacity: 1;
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--edge-color) 46%, transparent));
    animation: peak-run-dash 1.4s linear infinite, peak-run-glow 1.8s ease-in-out infinite alternate;
  }
  /* Concluded Intents settle once with a brief glow, then rest solid. */
  .intent-edge.enter .edge:not(.open):not(.profiled) {
    animation: peak-edge-settle 0.9s ease-out;
  }
  /* Chain spotlight: edges inside the selected Fact's proof chain. */
  .intent-edge.chain-focus .edge {
    stroke-width: calc(4px * var(--edge-scale, 1));
    opacity: 1;
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--edge-color) 58%, transparent));
  }
  .intent-edge.chain-focus .edge.open, .intent-edge.chain-focus .edge.profiled { animation-duration: 1.3s; }
  .edge.selected {
    stroke: var(--edge-color);
    stroke-width: calc(4.25px * var(--edge-scale, 1));
    marker-end: url(#arrow);
    filter: drop-shadow(0 0 5px color-mix(in srgb, var(--edge-color) 55%, transparent));
  }
  .edge.selected.branch { marker-end: none; }
  .intent-edge.dragging .edge { stroke-width: calc(4.25px * var(--edge-scale, 1)); }
  .edge-junction {
    fill: var(--panel);
    stroke: var(--edge-color);
    stroke-width: 2.4;
    filter: drop-shadow(0 1px 2px color-mix(in srgb, var(--edge-color) 30%, transparent));
  }
  .edge-junction.selected { stroke: var(--edge-color); stroke-width: 3.5; }
  .open-terminal { fill: color-mix(in srgb, var(--edge-color) 12%, var(--panel)); stroke: var(--edge-color); stroke-width: 2.8; }
  /* Waiting open terminal breathes slowly. */
  .open-terminal:not(.profiled) { animation: peak-open-pulse 2.6s ease-in-out infinite; }
  .open-terminal.profiled {
    fill: color-mix(in srgb, var(--edge-color) 18%, var(--panel));
    stroke: var(--edge-color);
    filter: drop-shadow(0 0 5px color-mix(in srgb, var(--edge-color) 50%, transparent));
  }
  .edge-hit { fill: none; stroke: transparent; stroke-width: 18; cursor: pointer; }
  .intent-label { cursor: grab; touch-action: none; user-select: none; }
  .intent-label.dragging { cursor: grabbing; }
  .intent-label rect {
    fill: color-mix(in srgb, var(--edge-color) 7%, var(--panel));
    stroke: color-mix(in srgb, var(--edge-color) 58%, var(--line));
    stroke-width: 1.15;
    filter: drop-shadow(0 3px 6px color-mix(in srgb, var(--ink) 12%, transparent));
  }
  .intent-label text {
    font: 780 9px var(--mono);
    letter-spacing: 0.04em;
    fill: color-mix(in srgb, var(--edge-color) 84%, var(--ink));
  }
  .intent-label.open rect {
    fill: color-mix(in srgb, var(--edge-color) 8%, var(--panel));
    stroke: var(--edge-color);
    stroke-dasharray: 3 2;
  }
  .intent-label.open text { fill: var(--edge-color); }
  .intent-label.profiled rect { fill: color-mix(in srgb, var(--edge-color) 13%, var(--panel)); stroke: var(--edge-color); }
  .intent-label.profiled text { fill: var(--edge-color); }
  .intent-label.selected rect {
    fill: color-mix(in srgb, var(--edge-color) 16%, var(--panel));
    stroke: var(--edge-color);
    stroke-width: 2.2;
  }
  .intent-label.selected text { fill: color-mix(in srgb, var(--edge-color) 88%, var(--ink)); }
  .intent-label.profiled rect { animation: peak-run-pulse 1.8s ease-in-out infinite alternate; }
  .open-terminal.profiled { animation: peak-run-pulse 1.8s ease-in-out infinite alternate; }

  @keyframes peak-run-dash { to { stroke-dashoffset: -38; } }
  @keyframes peak-open-dash { to { stroke-dashoffset: -28; } }
  @keyframes peak-open-pulse {
    0%, 100% { opacity: 0.5; filter: none; }
    50% { opacity: 1; filter: drop-shadow(0 0 4px color-mix(in srgb, var(--edge-color) 45%, transparent)); }
  }
  @keyframes peak-edge-settle {
    0% { opacity: 0; filter: drop-shadow(0 0 9px color-mix(in srgb, var(--edge-color) 68%, transparent)); }
    45% { opacity: 1; filter: drop-shadow(0 0 7px color-mix(in srgb, var(--edge-color) 55%, transparent)); }
    100% { opacity: 1; filter: drop-shadow(0 1px 1px color-mix(in srgb, var(--edge-color) 22%, transparent)); }
  }
  @keyframes peak-run-glow {
    from { filter: drop-shadow(0 0 2px color-mix(in srgb, var(--edge-color) 42%, transparent)); }
    to { filter: drop-shadow(0 0 7px color-mix(in srgb, var(--edge-color) 76%, transparent)); }
  }
  @keyframes peak-run-pulse {
    from { filter: drop-shadow(0 0 1px color-mix(in srgb, var(--edge-color) 35%, transparent)); }
    to { filter: drop-shadow(0 0 7px color-mix(in srgb, var(--edge-color) 72%, transparent)); }
  }
  @keyframes peak-node-enter { from { opacity: 0; } to { opacity: 1; } }
  @keyframes peak-node-flash {
    0% { stroke-width: 3.5; filter: drop-shadow(0 0 9px color-mix(in srgb, var(--accent) 45%, transparent)); }
    100% { filter: drop-shadow(0 5px 8px color-mix(in srgb, var(--ink) 9%, transparent)); }
  }
  .graph-node.enter { animation: peak-node-enter 0.55s ease both; }
  .graph-node.enter rect { animation: peak-node-flash 1.4s ease-out; }
  .intent-edge.enter { animation: peak-node-enter 0.55s ease both; }

  /* Inspector ---------------------------------------------------------------- */
  .inspector {
    min-height: 0;
    background: var(--panel);
    border-left: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    animation: peak-side-in-r 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .tabs { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--line); }
  .tab {
    border: 0;
    background: transparent;
    padding: 13px;
    color: var(--faint);
    font-size: 12px;
    font-weight: 700;
    border-bottom: 2px solid transparent;
    transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
  }
  .tab:hover { color: var(--muted); background: var(--panel-2); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab .count {
    display: inline-grid;
    place-items: center;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    margin-left: 4px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--line-2);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
  }
  .tab.active .count { background: var(--accent-soft); border-color: var(--accent-line); }
  .panel { min-height: 0; overflow: auto; padding: 16px; }
  .placeholder {
    padding: 34px 13px;
    text-align: center;
    border: 1px dashed var(--line);
    border-radius: 13px;
    color: var(--faint);
    font-size: 12.5px;
  }
  .detail-card {
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
    background: var(--panel);
    box-shadow: var(--shadow-sm);
    animation: peak-card-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .detail-head code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-head {
    padding: 11px 13px;
    background: var(--panel-2);
    border-bottom: 1px solid var(--line-2);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .detail-head code { font: 750 11px var(--mono); color: var(--accent-ink); }
  .detail-body { padding: 14px; }
  .detail-body p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink-2); font-size: 13px; }
  .meta { margin: 14px 0 0; padding: 12px 0 0; border-top: 1px solid var(--line-2); display: grid; gap: 8px; }
  .meta div { display: grid; grid-template-columns: 76px 1fr; gap: 8px; font-size: 11px; }
  .meta dt { color: var(--faint); }
  .meta dd { margin: 0; color: var(--muted); text-align: right; overflow-wrap: anywhere; }
  .meta dd.path { font: 10px/1.45 var(--mono); text-align: left; color: var(--accent-ink); word-break: break-all; }
  .artifact {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    color: var(--accent);
    text-decoration: none;
    font-size: 12px;
    font-weight: 650;
  }
  .artifact:hover { text-decoration: underline; }

  /* Hints --------------------------------------------------------------------- */
  .hint-compose {
    border: 1px solid color-mix(in srgb, var(--amber) 28%, var(--line));
    border-radius: 14px;
    padding: 13px;
    background: var(--amber-soft);
  }
  .hint-compose label { display: block; margin-bottom: 6px; font-size: 11px; font-weight: 720; color: var(--amber); }
  .hint-compose textarea, .hint-compose input {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--panel);
    color: var(--ink);
    padding: 9px 10px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .hint-compose textarea { min-height: 90px; resize: vertical; }
  .hint-compose textarea:focus, .hint-compose input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .compose-foot { display: flex; align-items: end; gap: 8px; margin-top: 8px; }
  .compose-foot .actor { flex: 1; }
  .hint-list { display: grid; gap: 9px; margin-top: 13px; }
  .hint-card {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    padding: 11px;
    text-align: left;
    width: 100%;
    color: var(--ink);
    transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
  }
  .hint-card:hover { background: var(--panel-2); border-color: var(--faint); }
  .hint-card.selected {
    border-color: var(--amber);
    background: var(--amber-soft);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--amber) 16%, transparent);
  }
  .hint-card p { margin: 7px 0 0; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
  .hint-meta { display: flex; justify-content: space-between; gap: 7px; color: var(--amber); font-size: 10px; font-weight: 650; }
  .hint-meta strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint-meta span { flex: none; }
  .hint-card.enter { animation: peak-card-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both; }

  /* Toast ----------------------------------------------------------------------- */
  .toast {
    position: fixed;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%) translateY(0);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 15px;
    background: var(--ink);
    color: var(--bg);
    border-radius: 11px;
    box-shadow: var(--shadow-lg);
    font-size: 12.5px;
    animation: peak-toast-in 0.25s ease;
    max-width: min(480px, 86vw);
  }
  .toast::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--teal);
    flex: none;
  }
  .toast.error::before { background: var(--rose); }
  .toast.leaving { opacity: 0; transform: translateX(-50%) translateY(8px); transition: opacity 0.3s ease, transform 0.3s ease; }
  @keyframes peak-toast-in { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

  .mobile-projects { display: none; }
  /* Tablet landscape: narrower side rails, keep the three-pane layout. */
  @media (max-width: 1050px) {
    .shell { grid-template-columns: 248px minmax(0, 1fr) 300px; }
    .project-heading strong { max-width: 26vw; }
  }
  /* Tablet portrait / small: stack panes; project switcher moves into the topbar. */
  @media (max-width: 820px) {
    .shell {
      grid-template-columns: 1fr;
      grid-template-rows: 58px minmax(0, 1fr) clamp(230px, 36dvh, 320px);
    }
    .sidebar { display: none; }
    .workspace { grid-column: 1; }
    .inspector { grid-column: 1; border-left: 0; border-top: 1px solid var(--line); }
    .mobile-projects {
      display: block;
      max-width: 42vw;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 6px;
    }
    .brand span { display: none; }
    .toolbar .label { display: none; }
    .legend { display: none; }
    .topbar { gap: 8px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: 10px; }
    .graph-tools { top: 10px; left: 10px; }
    .tab { padding: 12px 8px; }
    .panel { padding: 12px; }
  }
  /* Phones: tighten chrome further, drop secondary actions, maximize canvas. */
  @media (max-width: 560px) {
    .shell { grid-template-rows: 54px minmax(0, 1fr) clamp(220px, 34dvh, 300px); }
    .topbar { gap: 6px; padding-right: 8px; }
    .project-heading { display: none; }
    .mobile-projects { max-width: 52vw; font-size: 12px; padding: 5px; }
    .toolbar { gap: 5px; }
    .toolbar #export { display: none; }
    .status { padding: 2px 7px; font-size: 9px; }
    .canvas-empty { font-size: 12px; padding: 16px; }
    .toast {
      left: 12px;
      right: 12px;
      bottom: 12px;
      max-width: none;
      transform: translateY(0);
    }
    .toast.leaving { transform: translateY(8px); }
    @keyframes peak-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  }
  /* Coarse pointers: bigger touch targets on the canvas and lists. */
  @media (pointer: coarse) {
    .edge-hit { stroke-width: 24px; }
    .tab { min-height: 44px; }
    .hint-card { padding: 13px 12px; }
    .project-card { padding: 14px 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .topbar, .sidebar, .inspector, .workspace, .project-card.enter, .hint-card.enter, .detail-card,
    .graph-node.enter, .graph-node.enter rect, .intent-edge.enter, .intent-edge.enter .edge,
    .intent-label.profiled rect, .open-terminal, .edge.profiled, .edge.open { animation: none !important; }
  }
`,Ge=class extends C{static styles=[J,Xt];projects=[];graph=null;resolved=new Map;projectId=null;selected=null;chainFocus=null;summaries=new Map;summaryRequested=new Set;listAnimated=!1;seenHints=new Set;edgeUpdaters=new Map;dragRaf=0;pendingEdgeUpdates=[];signature="";camera={x:0,y:0,k:1};bounds={x:0,y:0,width:1,height:1};layout=null;layers=null;suppressNodeClick=null;suppressIntentClick=null;fittedProject=null;refreshing=!1;knownNodes=null;knownEdges=null;enterNodes=new Set;enterEdges=new Set;pollTimer=null;toastTimer=null;el;render(){return $`
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <span class="logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m4 18 5-7 3 4 3-6 5 9"/><path d="M4 20h16"/>
              </svg>
            </span>
            <span>Peak Graph</span>
          </div>
          <select id="mobile-projects" class="mobile-projects" aria-label="Source"></select>
          <div id="project-heading" class="project-heading hidden">
            <strong id="project-title"></strong><span id="project-status" class="status"></span>
          </div>
          <div class="spacer"></div>
          <div class="toolbar">
            <button class="btn icon-btn theme-toggle" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
            <a class="btn" href="/tasks.html" title="Task management">Tasks</a>
            <button id="export" class="btn hidden"><span class="label" id="export-label">Snapshot</span></button>
            <button id="status-action" class="btn warn hidden"></button>
            <button id="refresh" class="btn icon-btn" title="Refresh" aria-label="Refresh">↻</button>
          </div>
        </header>

        <aside class="sidebar">
          <div class="side-head"><span class="eyebrow">Sources</span><span id="project-count" class="count-badge">0</span></div>
          <div id="project-list" class="project-list"></div>
        </aside>

        <main class="workspace">
          <div class="graph-tools">
            <button id="fit" class="btn icon-btn" title="Fit graph" aria-label="Fit graph">⌗</button>
            <button id="arrange" class="btn icon-btn" title="Reset node layout" aria-label="Reset node layout">↦</button>
          </div>
          <div id="canvas-empty" class="canvas-empty">
            <div>
              <div class="mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m3 18 5-7 3 4 3-6 5 9"/><path d="M3 20h18"/>
                </svg>
              </div>
              <strong>Select a Source</strong>Choose a source to inspect its proof graph.
            </div>
          </div>
          <div id="viewport" class="hidden">
            <svg id="graph" role="img" aria-label="Balanced proof DAG, with Facts connected by directed Intent edges">
              <defs>
                <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 z" fill="context-stroke"/>
                </marker>
              </defs>
              <g id="scene"></g>
            </svg>
          </div>
          <div id="legend" class="legend hidden">
            <span><i class="dot"></i>Fact</span>
            <span><i class="dot external"></i>External Fact</span>
            <span><i class="dot intent"></i>Intent · unique color</span>
            <span><i class="dot hint"></i>Hint</span>
          </div>
        </main>

        <aside class="inspector">
          <div class="tabs">
            <button class="tab active" data-tab="detail">Detail</button>
            <button class="tab" data-tab="hints">Hints <span id="hint-count" class="count">0</span></button>
          </div>
          <div id="detail-panel" class="panel"></div>
          <div id="hints-panel" class="panel hidden">
            <form id="hint-form" class="hint-compose">
              <label for="hint-content">Add guidance to this Source project</label>
              <textarea id="hint-content" maxlength="1024" required placeholder="What should the runtime reconsider, verify, or prioritize?"></textarea>
              <div class="compose-foot">
                <div class="actor">
                  <label for="hint-creator">Creator</label>
                  <input id="hint-creator" maxlength="120" value="human:web" required>
                </div>
                <button class="btn primary" type="submit">Add Hint</button>
              </div>
            </form>
            <div id="hint-list" class="hint-list"></div>
          </div>
        </aside>
      </div>
      <div id="toast" class="toast hidden" role="status"></div>
    `}firstUpdated(){let e=this.shadowRoot,t=r=>e.querySelector(r);this.el={list:t("#project-list"),count:t("#project-count"),mobile:t("#mobile-projects"),heading:t("#project-heading"),title:t("#project-title"),status:t("#project-status"),statusAction:t("#status-action"),exportBtn:t("#export"),exportLabel:t("#export-label"),empty:t("#canvas-empty"),viewport:t("#viewport"),scene:t("#scene"),legend:t("#legend"),detail:t("#detail-panel"),hints:t("#hints-panel"),hintCount:t("#hint-count"),hintList:t("#hint-list"),hintForm:t("#hint-form"),content:t("#hint-content"),creator:t("#hint-creator"),toast:t("#toast")},this.el.creator.value=localStorage.getItem("peak-hint-creator")??"human:web",e.querySelectorAll(".tab").forEach(r=>{r.onclick=()=>this.setTab(r.dataset.tab??"detail")}),this.el.hintForm.onsubmit=r=>{this.submitHint(r)},this.el.statusAction.onclick=()=>{this.changeStatus()},this.el.exportBtn.onclick=()=>{this.exportSnapshot()},t("#fit").onclick=()=>this.fitGraph(),t("#arrange").onclick=()=>this.resetNodeLayout(),t("#refresh").onclick=()=>{this.refresh(!0)},t("#theme").onclick=()=>{X(),this.renderGraph()},this.el.mobile.onchange=()=>{this.el.mobile.value&&this.selectProject(this.el.mobile.value)},window.addEventListener("hashchange",()=>{let r=location.hash.slice(1);r&&r!==this.projectId&&this.selectProject(r)}),window.addEventListener("resize",()=>{this.graph&&this.fittedProject!==this.projectId&&this.fitGraph()}),this.setupPanZoom();let n=location.hash.slice(1);n&&(this.projectId=n),this.refresh(!0),this.pollTimer=window.setInterval(()=>{document.hidden||this.refresh(!1)},2500)}disconnectedCallback(){super.disconnectedCallback(),this.pollTimer!==null&&window.clearInterval(this.pollTimer),this.toastTimer!==null&&window.clearTimeout(this.toastTimer),this.dragRaf&&cancelAnimationFrame(this.dragRaf)}async refresh(e=!1){if(!this.refreshing){this.refreshing=!0;try{let t=await j("/api/projects");this.projects=t,this.renderProjectList(),this.ensureSummaries(t),this.projectId&&!t.some(n=>n.id===this.projectId)&&(this.projectId=null,this.graph=null,history.replaceState(null,"",location.pathname),this.renderEmpty()),this.projectId?await this.loadGraph(e):t.length===1&&await this.selectProject(t[0].id)}catch(t){this.notify(t.message,!0)}finally{this.refreshing=!1}}}renderProjectList(){let{el:e}=this;e.count.textContent=String(this.projects.length),e.list.replaceChildren(),e.mobile.replaceChildren();let t=document.createElement("option");if(t.value="",t.textContent="Select source",e.mobile.append(t),!this.projects.length){let r=document.createElement("div");r.className="empty",r.innerHTML="<strong>No Sources</strong>Project sources created by Peak will appear here.",e.list.append(r);return}let n=!this.listAnimated;this.listAnimated=!0,this.projects.forEach((r,s)=>{let a=this.summaries.get(r.id),o=a?.source??r.title,l=a?.goal??"",c=document.createElement("button");c.className=`project-card${r.id===this.projectId?" active":""}${n?" enter":""}`,n&&(c.style.animationDelay=`${Math.min(s,8)*45}ms`),c.type="button",c.title=r.title;let d=document.createElement("div");d.className="project-card-title";let p=document.createElement("span");p.className=`status ${r.status}`,p.textContent=r.status,d.append(p);let h=document.createElement("div");h.className="project-line";let m=document.createElement("b");m.textContent="SRC";let b=document.createElement("span");b.textContent=o,h.append(m,b);let f=document.createElement("div");f.className="project-line goal";let v=document.createElement("b");v.textContent="GOAL";let g=document.createElement("span");g.textContent=l||"\u2014",f.append(v,g);let S=document.createElement("p");S.textContent=`Created ${G(r.createdAt)}`;let w=document.createElement("code");w.textContent=r.id,c.append(d,h,f,S,w),c.onclick=()=>{this.selectProject(r.id)},e.list.append(c);let A=document.createElement("option");A.value=r.id,A.textContent=`${o} \xB7 ${r.status}`,A.selected=r.id===this.projectId,e.mobile.append(A)})}ensureSummaries(e){let t=e.filter(n=>!this.summaries.has(n.id)&&!this.summaryRequested.has(n.id));if(t.length){for(let n of t)this.summaryRequested.add(n.id);Promise.all(t.map(async n=>{let r={source:n.title,goal:""};try{let s=await j(`/api/projects/${encodeURIComponent(n.id)}`);r={source:s.facts.find(a=>a.id==="origin")?.description??n.title,goal:s.facts.find(a=>a.id==="goal")?.description??""}}catch{}this.summaries.set(n.id,r)})).then(()=>this.renderProjectList())}}async selectProject(e){this.projectId=e,this.selected=null,this.chainFocus=null,this.signature="",this.fittedProject=null,this.knownNodes=null,this.knownEdges=null,this.seenHints=new Set,location.hash=e,this.renderProjectList(),await this.loadGraph(!0)}async loadGraph(e=!1){if(!this.projectId)return;let t=await j(`/api/projects/${encodeURIComponent(this.projectId)}`),n=JSON.stringify(t),r=new Set,s=[];for(let o of t.intents)for(let l of o.from){if(l.projectId===this.projectId)continue;let c=E(l);r.has(c)||(r.add(c),s.push(l))}if(this.resolved=new Map,s.length)try{let o=await j("/api/fact-refs/resolve",{method:"POST",body:{targetProjectId:this.projectId,refs:s}});for(let l of o)this.resolved.set(E(l.ref),l.fact)}catch{}let a=n!==this.signature;this.graph=t,this.signature=n,this.summaries.has(t.project.id)||(this.summaries.set(t.project.id,{source:t.facts.find(o=>o.id==="origin")?.description??t.project.title,goal:t.facts.find(o=>o.id==="goal")?.description??""}),this.renderProjectList()),this.renderHeader(),this.renderHints(),(a||e)&&(this.renderGraph(),this.renderDetail())}renderHeader(){let e=this.graph,{el:t}=this;if(!e){this.renderEmpty();return}t.heading.classList.remove("hidden"),t.exportBtn.classList.remove("hidden"),t.statusAction.classList.remove("hidden"),t.title.textContent=e.project.title,t.status.className=`status ${e.project.status}`,t.status.textContent=e.project.status,t.exportLabel.textContent=e.project.status==="completed"?"Archive":"Snapshot",e.project.status==="completed"?(t.statusAction.textContent="Reopen",t.statusAction.className="btn primary"):(t.statusAction.textContent=e.project.status==="active"?"Stop":"Resume",t.statusAction.className=e.project.status==="active"?"btn warn":"btn primary"),t.empty.classList.add("hidden"),t.viewport.classList.remove("hidden"),t.legend.classList.remove("hidden"),t.hintCount.textContent=String(e.hints.length);let n=t.hintForm.querySelector("button");n.disabled=!1}renderEmpty(){this.graph=null;let{el:e}=this;e.heading.classList.add("hidden"),e.exportBtn.classList.add("hidden"),e.statusAction.classList.add("hidden"),e.viewport.classList.add("hidden"),e.legend.classList.add("hidden"),e.empty.classList.remove("hidden"),e.hintCount.textContent="0",this.renderDetail(),this.renderHints()}renderGraph(){let{el:e}=this;if(this.dragRaf&&(cancelAnimationFrame(this.dragRaf),this.dragRaf=0,this.pendingEdgeUpdates=[]),e.scene.replaceChildren(),!this.graph)return;this.selected?.type==="fact"&&(this.chainFocus=Oe(this.graph,this.selected.id));let t=Et(this.graph,this.resolved);this.layout=t,this.layers={guides:this.svg("g",{}),edges:this.svg("g",{class:"edge-layer"}),nodes:this.svg("g",{})},e.scene.append(this.layers.guides,this.layers.edges,this.layers.nodes),this.updateLayoutBounds();let n=!this.knownNodes;this.enterNodes=n?new Set:new Set(t.nodes.map(r=>r.key).filter(r=>!this.knownNodes.has(r))),this.enterEdges=n?new Set:new Set(t.edges.map(r=>r.id).filter(r=>!this.knownEdges.has(r))),this.knownNodes=new Set(t.nodes.map(r=>r.key)),this.knownEdges=new Set(t.edges.map(r=>r.id)),this.drawLayoutGuides(t),this.redrawEdges();for(let r of t.nodes)this.drawNode(r);this.enterNodes=new Set,this.enterEdges=new Set,this.applyCamera(),this.fittedProject!==this.projectId&&(requestAnimationFrame(()=>this.fitGraph()),this.fittedProject=this.projectId)}svg(e,t){let n=document.createElementNS(Vt,e);for(let[r,s]of Object.entries(t))n.setAttribute(r,String(s));return n}drawLayoutGuides(e){if(!this.layers)return;let t=this.layers.guides,n=this.svg("text",{x:e.pad,y:34,class:"layout-label"});if(n.textContent="PROOF DAG  \xB7  DRAG FACTS AND INTENTS TO REFINE THE LAYOUT",t.append(n),e.hintTop!==null){let r=e.hintTop-55;t.append(this.svg("line",{x1:e.pad,y1:r,x2:e.width-e.pad,y2:r,class:"layout-rule"}));let s=this.svg("text",{x:e.pad,y:r+25,class:"layout-label"});s.textContent="HINTS  \xB7  INDEPENDENT GRAPH INPUTS",t.append(s)}}updateLayoutBounds(){if(!this.layout)return;let e=this.layout.nodes,t=this.layout.edges.flatMap(o=>[xe(o),o.handle]),n=Math.min(0,...e.map(o=>o.x-55),...t.map(o=>o.x-90)),r=Math.min(0,...e.map(o=>o.y-55),...t.map(o=>o.y-45),-10),s=Math.max(this.layout.width,...e.map(o=>o.x+o.w+55),...t.map(o=>o.x+90)),a=Math.max(this.layout.height,...e.map(o=>o.y+o.h+55),...t.map(o=>o.y+45));this.bounds={x:n,y:r,width:s-n,height:a-r}}redrawEdges(){if(!this.layers||!this.layout)return;this.edgeUpdaters.clear(),this.layers.edges.replaceChildren();let e=[...this.layout.edges].sort((t,n)=>{let r=s=>Math.abs(xe(s).x-Math.min(...s.sources.map(a=>a.x)));return r(n)-r(t)});for(let t of e)this.drawEdge(t)}drawEdge(e){if(!this.layers)return;let t=null,n=this.selected?.type==="intent"&&this.selected.id===e.id,r=this.chainFocus?.edges.has(e.id)??!1,s=this.chainFocus?!r:this.selected?.type==="intent"&&!n,a=`--edge-color:${ze(e.id,ae())}`,o=this.svg("g",{class:`intent-edge${this.enterEdges.has(e.id)?" enter":""}${n?" selected-edge":""}${r?" chain-focus":s?" context-dimmed":""}`,style:a});this.layers.edges.append(o);let l=[],c=(g,S=!1)=>{let w=`edge${S?" branch":""}${e.profiled?" profiled":e.open?" open":""}${n?" selected":""}`,A=g(),P=this.svg("path",{d:A,class:"edge-casing"}),I=this.svg("path",{d:A,class:w,style:a}),_=this.svg("path",{d:A,class:"edge-hit"});_.addEventListener("click",N=>{N.stopPropagation(),this.selectItem("intent",e.id)}),_.addEventListener("pointerdown",N=>{N.preventDefault(),N.stopPropagation(),t&&this.beginIntentDrag(N,e,t)}),o.append(P,I,_),l.push(()=>{let N=g();P.setAttribute("d",N),I.setAttribute("d",N),_.setAttribute("d",N)})},d=()=>{let g=e.sources.map(D);return{x:g.reduce((S,w)=>S+w.x,0)/g.length,y:g.reduce((S,w)=>S+w.y,0)/g.length}};if(e.sources.length===1){let g=e.sources[0];c(()=>de(ve(g,e.handle),e.handle),!!e.target)}else{let g=()=>{let A=d(),P=e.handle.x-A.x,I=e.handle.y-A.y,_=Math.hypot(P,I)||1;return{x:e.handle.x-P/_*58,y:e.handle.y-I/_*58}};for(let A of e.sources)c(()=>{let P=g();return de(ve(A,P),P)},!0);c(()=>de(g(),e.handle),!!e.target);let S=g(),w=this.svg("circle",{cx:S.x,cy:S.y,r:4,class:`edge-junction${e.open?" open":""}${n?" selected":""}`,style:a});o.append(w),l.push(()=>{let A=g();w.setAttribute("cx",String(A.x)),w.setAttribute("cy",String(A.y))})}if(e.target){let g=e.target;c(()=>de(e.handle,ve(g,e.handle)))}else{let g=this.svg("circle",{cx:e.handle.x,cy:e.handle.y,r:5,class:`open-terminal${e.profiled?" profiled":""}`,style:a});o.append(g),l.push(()=>{g.setAttribute("cx",String(e.handle.x)),g.setAttribute("cy",String(e.handle.y))})}let p=Ue(e),h=this.svg("g",{class:`intent-label${e.profiled?" profiled":e.open?" open":""}${n?" selected":""}`,transform:`translate(${e.handle.x} ${e.handle.y})`,tabindex:"0",role:"button",style:a}),m=this.svg("title",{});m.textContent=`Drag to reroute \xB7 ${e.record.description}`;let b=this.svg("rect",{x:-p/2,y:-11,width:p,height:22,rx:11}),f=this.svg("text",{x:0,y:3,"text-anchor":"middle"});f.textContent=Re(e);let v=this.svg("rect",{x:-p/2-7,y:-17,width:p+14,height:34,rx:17,fill:"transparent"});h.append(m,v,b,f),t=h,h.addEventListener("pointerdown",g=>this.beginIntentDrag(g,e,h)),h.addEventListener("click",g=>{g.stopPropagation(),this.suppressIntentClick!==e.id&&this.selectItem("intent",e.id)}),h.addEventListener("keydown",g=>{(g.key==="Enter"||g.key===" ")&&(g.preventDefault(),h.dispatchEvent(new MouseEvent("click")))}),o.append(h),l.push(()=>h.setAttribute("transform",`translate(${e.handle.x} ${e.handle.y})`)),this.edgeUpdaters.set(e.id,()=>{for(let g of l)g()})}drawNode(e){if(!this.layers)return;let t=At(e,ae()),n=this.chainFocus?this.chainFocus.nodes.has(e.key)?" chain-focus":" context-dimmed":this.intentNodeClass(e),r=n.includes("intent-endpoint")&&this.selected?.type==="intent"?ze(this.selected.id,ae()):null,s=this.svg("g",{class:`graph-node${this.enterNodes.has(e.key)?" enter":""}${this.isSelectedNode(e)?" selected":""}${n}`,transform:`translate(${e.x} ${e.y})`,tabindex:"0",role:"button",...r?{style:`--endpoint-color:${r}`}:{}}),a=this.svg("rect",{width:e.w,height:e.h,rx:13,fill:t.fill,stroke:t.stroke,"stroke-width":2}),o=this.svg("text",{x:14,y:20,class:"node-type",fill:t.accent});o.textContent=e.type==="hint"?"HINT":e.type==="external"?"FACT \xB7 EXTERNAL":e.id==="origin"?"FACT \xB7 SOURCE":e.id==="goal"?"FACT \xB7 GOAL":"FACT";let l=this.svg("text",{x:e.w-14,y:20,class:"node-id",fill:t.accent,"text-anchor":"end"});l.textContent=e.id,s.append(a),e.type==="external"&&s.append(this.svg("rect",{x:0,y:9,width:7,height:e.h-18,rx:3.5,fill:t.accent,opacity:.82})),s.append(o,l),St(e.description,e.type==="hint"?186:206,e.type==="hint"?2:3).forEach((d,p)=>{let h=this.svg("text",{x:14,y:44+p*16,class:"node-text"});h.textContent=d,s.append(h)}),s.addEventListener("pointerdown",d=>this.beginNodeDrag(d,e,s)),s.addEventListener("click",d=>{d.stopPropagation(),this.suppressNodeClick!==e.key&&this.selectItem(e.type==="hint"?"hint":"fact",e.key)}),s.addEventListener("keydown",d=>{(d.key==="Enter"||d.key===" ")&&(d.preventDefault(),s.dispatchEvent(new MouseEvent("click")))}),this.layers.nodes.append(s)}isSelectedNode(e){if(!this.selected)return!1;let t=this.selected.type==="fact"?this.selected.id:this.selected.type==="hint"?`hint:${this.selected.id}`:null;return!!(t&&t===e.key)}intentNodeClass(e){if(this.selected?.type!=="intent")return"";let t=this.graph?.intents.find(r=>r.id===this.selected.id);return t?t.from.some(r=>E(r)===e.key)||t.to!==null&&E(t.to)===e.key?" intent-endpoint":e.type==="fact"&&(e.id==="origin"||e.id==="goal")?" intent-anchor":" context-dimmed":""}selectItem(e,t){this.selected=this.selected?.type===e&&this.selected.id===t?null:{type:e,id:t},this.chainFocus=this.selected?.type==="fact"&&this.graph?Oe(this.graph,this.selected.id):null,this.renderGraph(),this.renderDetail(),e==="hint"&&this.setTab("hints")}clearSelection(){this.selected&&(this.selected=null,this.chainFocus=null,this.renderGraph(),this.renderDetail())}renderDetail(){let{el:e}=this;if(e.detail.replaceChildren(),!this.graph||!this.selected){let f=document.createElement("div");f.className="placeholder",f.textContent="Select a Fact, Intent edge, or Hint.",e.detail.append(f);return}let t="",n="",r=[],s=null,a="",{type:o,id:l}=this.selected;if(o==="intent"){let f=this.graph.intents.find(v=>v.id===l);if(!f)return;t=`Intent ${f.id}`,n=f.description,r.push(["Status",f.to?"concluded":"open"],["Custom profile",f.customProfile??"\u2014"],["Profile digest",f.customProfileDigest??"\u2014"],["Hints",f.hintIds?.join(", ")||"\u2014"],["From",f.from.map(v=>`${ut(v.projectId,this.projectId??void 0)}/${v.id}`).join(", ")],["To",f.to?f.to.id:"\u2014"],["Created by",f.createdBy],["Created",G(f.createdAt)],["Concluded by",f.concludedBy??"\u2014"],["Concluded at",f.concludedAt?G(f.concludedAt):"\u2014"])}else if(o==="hint"){let f=this.graph.hints.find(v=>v.id===l);if(!f)return;t=`Hint ${f.id}`,n=f.content,r.push(["Consumed by",f.consumedByIntentId??"\u2014"],["Consumed at",f.consumedAt?G(f.consumedAt):"\u2014"],["Creator",f.creator],["Created",G(f.createdAt)])}else{let[f,v]=xt(l),g=f===this.projectId,S=g?null:this.graph.intents.flatMap(P=>P.from).find(P=>E(P)===l),w=g?this.graph.facts.find(P=>P.id===v):this.resolved.get(l)??S;t=g?`Fact ${v}`:`FactRef ${v}`,n=w?.description??"\u2014",r.push(["Project",g?"current":f],["Fact",v],["Created",w?.createdAt?G(w.createdAt):"\u2014"]);let A=w?.artifact;A?(s=A,a=f,r.push(["Path",s.path??s.inputPath??"\u2014"],["Media type",s.mediaType],["Size",ht(s.sizeBytes)],["SHA-256",s.sha256])):r.push(["Artifact","\u2014"])}let c=document.createElement("article");c.className="detail-card";let d=document.createElement("div");d.className="detail-head";let p=document.createElement("code");p.textContent=t,d.append(p);let h=document.createElement("div");h.className="detail-body";let m=document.createElement("p");m.textContent=n,h.append(m);let b=document.createElement("dl");b.className="meta";for(let[f,v]of r){let g=document.createElement("div"),S=document.createElement("dt");S.textContent=f;let w=document.createElement("dd");w.classList.toggle("path",f==="Path"),w.textContent=v,g.append(S,w),b.append(g)}if(h.append(b),s){let f=new URLSearchParams({project:a,artifact:s.sha256});s.filename&&f.set("filename",s.filename);let v=document.createElement("a");v.className="artifact",v.textContent="Preview artifact \u2197",v.href=`/preview.html?${f}`,h.append(v)}c.append(d,h),e.detail.append(c)}renderHints(){let{el:e}=this;e.hintList.replaceChildren();let t=this.graph?.hints??[];if(e.hintForm.classList.toggle("hidden",!this.graph),!t.length){let n=document.createElement("div");n.className="placeholder",n.textContent="No hints yet.",e.hintList.append(n);return}for(let n of[...t].reverse()){let r=!this.seenHints.has(n.id);this.seenHints.add(n.id);let s=document.createElement("button");s.type="button",s.className=`hint-card${r?" enter":""}${this.selected?.type==="hint"&&this.selected.id===n.id?" selected":""}`;let a=document.createElement("div");a.className="hint-meta";let o=document.createElement("strong");o.textContent=n.creator;let l=document.createElement("span");l.textContent=G(n.createdAt),a.append(o,l);let c=document.createElement("p");c.textContent=n.content,s.append(a,c),s.onclick=()=>this.selectItem("hint",n.id),e.hintList.append(s)}}setTab(e){this.shadowRoot.querySelectorAll(".tab").forEach(t=>{t.classList.toggle("active",t.dataset.tab===e)}),this.el.detail.classList.toggle("hidden",e!=="detail"),this.el.hints.classList.toggle("hidden",e!=="hints"),e==="hints"&&this.renderHints()}async submitHint(e){if(e.preventDefault(),!this.graph||!this.projectId)return;let t=this.el.content.value.trim(),n=this.el.creator.value.trim();if(!t||!n)return;let r=this.el.hintForm.querySelector("button");r.disabled=!0;try{localStorage.setItem("peak-hint-creator",n);let s=await j(`/api/projects/${this.projectId}/hints`,{method:"POST",body:{content:t,creator:n}});this.el.content.value="",this.selected={type:"hint",id:s.id},await this.loadGraph(!0),this.notify("Hint added to the Project")}catch(s){this.notify(s.message,!0)}finally{r.disabled=!1}}async changeStatus(){if(!(!this.graph||!this.projectId))try{let e=this.graph.project;if(e.status==="completed"){let t=prompt("Describe why this Project should be reopened:");if(!t?.trim())return;await j(`/api/projects/${this.projectId}/reopen`,{method:"POST",body:{description:t.trim(),creator:this.el.creator.value.trim()||"human:web"}}),this.notify("Project reopened")}else{let t=e.status==="active"?"stopped":"active";await j(`/api/projects/${this.projectId}/status`,{method:"PUT",body:{status:t}}),this.notify(`Project ${t}`)}await this.refresh(!0)}catch(e){this.notify(e.message,!0)}}async exportSnapshot(){if(this.projectId)try{let e,t;if(this.graph?.project.status==="completed"){let r=await fetch(`/api/projects/${this.projectId}/export?format=archive`);if(!r.ok){let s=await r.text();try{s=JSON.parse(s).error??s}catch{}throw new Error(s)}e=await r.blob(),t=`peak-${this.projectId}.tar.gz`}else{let r=await j(`/api/projects/${this.projectId}/export?format=json`);e=new Blob([`${JSON.stringify(r,null,2)}
`],{type:"application/json"}),t=`peak-${this.projectId}.json`}let n=document.createElement("a");n.href=URL.createObjectURL(e),n.download=t,n.click(),setTimeout(()=>URL.revokeObjectURL(n.href),1e3)}catch(e){this.notify(e.message,!0)}}fitGraph(){if(!this.graph)return;let e=this.el.viewport.getBoundingClientRect(),t=55,n=Math.min(1.25,Math.max(.18,Math.min((e.width-t*2)/this.bounds.width,(e.height-t*2)/this.bounds.height)));this.camera={k:n,x:(e.width-this.bounds.width*n)/2-this.bounds.x*n,y:(e.height-this.bounds.height*n)/2-this.bounds.y*n},this.applyCamera()}applyCamera(){this.el.scene.setAttribute("transform",`translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.k})`),this.el.scene.style.setProperty("--edge-scale",String(Math.max(.2,Math.min(1.15,Math.pow(this.camera.k,.78)))))}setupPanZoom(){let{el:e}=this,t=new Map,n=null,r=null,s=()=>{let[o,l]=[...t.values()];if(!o||!l)return;let c=e.viewport.getBoundingClientRect();r={k0:this.camera.k,d0:Math.max(24,Math.hypot(l.x-o.x,l.y-o.y)),x0:this.camera.x,y0:this.camera.y,px:(o.x+l.x)/2-c.left,py:(o.y+l.y)/2-c.top}};e.viewport.addEventListener("pointerdown",o=>{o.target.closest?.(".graph-node,.edge-hit,.intent-label")||(t.set(o.pointerId,{x:o.clientX,y:o.clientY}),e.viewport.setPointerCapture(o.pointerId),e.viewport.classList.add("dragging"),t.size===1?(n={x:o.clientX,y:o.clientY,cx:this.camera.x,cy:this.camera.y,moved:!1},r=null):t.size===2&&(n=null,s()))}),e.viewport.addEventListener("pointermove",o=>{if(!t.has(o.pointerId))return;if(t.set(o.pointerId,{x:o.clientX,y:o.clientY}),r&&t.size===2){let[d,p]=[...t.values()];if(!d||!p)return;let h=Math.max(24,Math.hypot(p.x-d.x,p.y-d.y)),m=Math.min(2.5,Math.max(.16,r.k0*(h/r.d0)));this.camera.k=m,this.camera.x=r.px-(r.px-r.x0)*(m/r.k0),this.camera.y=r.py-(r.py-r.y0)*(m/r.k0),this.applyCamera();return}if(!n)return;let l=o.clientX-n.x,c=o.clientY-n.y;!n.moved&&Math.hypot(l,c)<3||(n.moved=!0,this.camera.x=n.cx+l,this.camera.y=n.cy+c,this.applyCamera())});let a=(o,l=!1)=>{if(t.delete(o.pointerId),r&&t.size<2){r=null;let c=[...t.values()][0];c&&!l?n={x:c.x,y:c.y,cx:this.camera.x,cy:this.camera.y,moved:!0}:n=null}if(t.size===0){let c=!l&&!!(n&&!n.moved&&this.selected);n=null,r=null,e.viewport.classList.remove("dragging"),c&&this.clearSelection()}};e.viewport.addEventListener("pointerup",o=>a(o,!1)),e.viewport.addEventListener("pointercancel",o=>a(o,!0)),e.viewport.addEventListener("wheel",o=>{o.preventDefault();let l=e.viewport.getBoundingClientRect(),c=o.clientX-l.left,d=o.clientY-l.top,p=this.camera.k,h=Math.min(2.5,Math.max(.16,p*Math.exp(-o.deltaY*.001)));this.camera.x=c-(c-this.camera.x)*(h/p),this.camera.y=d-(d-this.camera.y)*(h/p),this.camera.k=h,this.applyCamera()},{passive:!1})}scheduleEdgeUpdates(e){for(let t of e)this.pendingEdgeUpdates.includes(t)||this.pendingEdgeUpdates.push(t);this.dragRaf||(this.dragRaf=requestAnimationFrame(()=>this.flushEdgeUpdates()))}flushEdgeUpdates(){this.dragRaf&&(cancelAnimationFrame(this.dragRaf),this.dragRaf=0);let e=this.pendingEdgeUpdates;this.pendingEdgeUpdates=[];for(let t of e)this.edgeUpdaters.get(t.id)?.()}beginNodeDrag(e,t,n){if(e.button!==0)return;e.stopPropagation();let r={x:e.clientX,y:e.clientY,nodeX:t.x,nodeY:t.y},s=this.layout?.edges.filter(c=>c.sources.includes(t)||c.target===t)??[],a=!1;n.setPointerCapture(e.pointerId),n.classList.add("dragging");let o=c=>{let d=(c.clientX-r.x)/this.camera.k,p=(c.clientY-r.y)/this.camera.k;!a&&Math.hypot(d,p)<3||(a=!0,t.x=r.nodeX+d,t.y=r.nodeY+p,n.setAttribute("transform",`translate(${t.x} ${t.y})`),this.scheduleEdgeUpdates(s))},l=()=>{n.classList.remove("dragging"),n.removeEventListener("pointermove",o),n.removeEventListener("pointerup",l),n.removeEventListener("pointercancel",l),this.flushEdgeUpdates(),this.updateLayoutBounds(),a&&(wt(this.projectId,t),this.suppressNodeClick=t.key,setTimeout(()=>{this.suppressNodeClick===t.key&&(this.suppressNodeClick=null)},120))};n.addEventListener("pointermove",o),n.addEventListener("pointerup",l),n.addEventListener("pointercancel",l)}beginIntentDrag(e,t,n){if(e.button!==0)return;e.preventDefault(),e.stopPropagation();let r={x:e.clientX,y:e.clientY,handleX:t.handle.x,handleY:t.handle.y},s={...t.handle},a=n.parentElement,o=!1;n.classList.add("dragging");let l=d=>{let p=(d.clientX-r.x)/this.camera.k,h=(d.clientY-r.y)/this.camera.k;if(!o&&Math.hypot(p,h)<3)return;o=!0,a?.classList.add("dragging");let m=ge(t,r.handleX+p,r.handleY+h,this.layout?.nodes??[],this.layout?.edges.filter(b=>b!==t)??[],s);t.handle=m,s.x=m.x,s.y=m.y,t.manual=!0,this.scheduleEdgeUpdates([t])},c=()=>{n.classList.remove("dragging"),a?.classList.remove("dragging"),window.removeEventListener("pointermove",l),window.removeEventListener("pointerup",c),window.removeEventListener("pointercancel",c),this.flushEdgeUpdates(),this.updateLayoutBounds(),o&&(kt(this.projectId,t),this.suppressIntentClick=t.id,setTimeout(()=>{this.suppressIntentClick===t.id&&(this.suppressIntentClick=null)},150))};window.addEventListener("pointermove",l),window.addEventListener("pointerup",c),window.addEventListener("pointercancel",c)}resetNodeLayout(){!this.graph||!this.projectId||($t(this.projectId),this.fittedProject=null,this.renderGraph(),this.notify("Graph layout reset"))}notify(e,t=!1){let{el:n}=this;n.toast.textContent=e,n.toast.className=`toast${t?" error":""}`,this.toastTimer!==null&&window.clearTimeout(this.toastTimer),this.toastTimer=window.setTimeout(()=>{n.toast.classList.add("leaving"),window.setTimeout(()=>n.toast.classList.add("hidden"),320)},2600)}};customElements.define("peak-dashboard",Ge);var Jt=U`
  :host { display: block; min-height: 100vh; min-height: 100dvh; background: var(--bg); }
  .shell { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: 58px minmax(0, 1fr); }
  @keyframes peak-bar-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-panel-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-card-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 max(18px, env(safe-area-inset-right)) 0 max(18px, env(safe-area-inset-left));
    background: var(--glass);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 5;
    backdrop-filter: blur(14px) saturate(1.4);
    animation: peak-bar-in 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  header .mark {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-2));
    box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  header .mark svg { width: 16px; }
  header strong { font-size: 14.5px; letter-spacing: -0.01em; }
  header .meta { min-width: 0; color: var(--muted); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }

  main { padding: 22px; max-width: 1320px; margin: 0 auto; width: 100%; min-height: 0; }
  .workspace { display: grid; grid-template-columns: minmax(320px, 0.92fr) minmax(430px, 1.08fr); gap: 18px; align-items: start; }
  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-md);
    overflow: hidden;
    animation: peak-panel-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .workspace .panel:nth-child(2) { animation-delay: 0.08s; }
  .panel-head { padding: 17px 18px 13px; border-bottom: 1px solid var(--line-2); }
  .panel-head h2 { margin: 0; font-size: 15px; letter-spacing: -0.01em; }
  .panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }

  .browser { min-height: calc(100vh - 102px); display: grid; grid-template-rows: auto minmax(150px, 1fr) auto; }
  .task-list { padding: 9px; display: grid; align-content: start; gap: 5px; max-height: calc(100vh - 350px); overflow: auto; }
  .task-option {
    width: 100%;
    border: 1px solid transparent;
    border-radius: 12px;
    background: transparent;
    padding: 12px;
    text-align: left;
    color: inherit;
    transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .task-option:hover { background: var(--panel-2); }
  .task-option.enter { animation: peak-card-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .task-option.selected {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .task-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .task-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .task-head .badge { flex: none; }
  .task-summary { margin-top: 7px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-summary code {
    font: 10px/1.35 var(--mono);
    display: block;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--faint);
  }
  .badge {
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border: 1px solid var(--line);
    color: var(--muted);
    white-space: nowrap;
  }
  .badge.running { color: var(--teal); border-color: color-mix(in srgb, var(--teal) 40%, transparent); background: var(--teal-soft); }
  .selection { border-top: 1px solid var(--line-2); padding: 15px 18px; background: var(--panel-2); }
  .selection h3 { margin: 0 0 4px; font-size: 14px; overflow-wrap: anywhere; }
  .selection .swap { animation: peak-card-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .meta { color: var(--muted); font: 11px/1.45 var(--mono); overflow-wrap: anywhere; }
  .projects { display: flex; gap: 6px; flex-wrap: wrap; margin: 11px 0; }
  .projects .badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .create-body { padding: 18px; }
  .grid { display: grid; gap: 12px; }
  .grid.two { grid-template-columns: 1fr 1fr; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); font-weight: 650; }
  input, textarea, select {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 9px 11px;
    font: 13px/1.45 var(--mono);
    color: var(--ink);
    background: var(--panel);
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  textarea { min-height: 142px; resize: vertical; }
  .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .form-note { color: var(--faint); font-size: 11px; margin: 0; align-self: center; }

  @media (max-width: 860px) {
    main { padding: 14px; }
    .workspace { grid-template-columns: 1fr; }
    .browser { min-height: auto; }
    .task-list { max-height: 420px; }
    .grid.two { grid-template-columns: 1fr; }
  }
  /* Phones: single-column chrome, roomier touch rows, fewer decorations. */
  @media (max-width: 640px) {
    header { gap: 8px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: 10px; }
    header .meta { display: none; }
    header strong { font-size: 13.5px; }
    main { padding: 10px; }
    .workspace { gap: 12px; }
    .panel-head { padding: 13px 14px 10px; }
    .panel-head h2 { font-size: 14px; }
    .task-option { padding: 13px 11px; }
    .task-head strong { font-size: 13px; }
    .selection { padding: 13px 14px; }
    .create-body { padding: 14px; }
    .form-actions { flex-direction: column; }
    .form-actions .btn { width: 100%; }
    .form-note { align-self: stretch; }
    .actions .btn { flex: 1; justify-content: center; }
  }
  @media (pointer: coarse) {
    .task-option { min-height: 52px; }
  }
  @media (prefers-reduced-motion: reduce) {
    header, .panel, .task-option.enter, .selection .swap { animation: none !important; }
  }
`,De=class extends C{static styles=[J,Jt];tasks=[];selectedName=null;note="";listError="";pollTimer=null;seenTasks=new Set;selectionShownFor=null;render(){let e=this.tasks.find(t=>t.name===this.selectedName)??null;return $`
      <div class="shell">
        <header>
          <span class="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 5h16M4 12h16M4 19h10"/>
            </svg>
          </span>
          <strong>Peak Tasks</strong>
          <span class="meta">${this.note}</span>
          <span class="spacer"></span>
          <button class="btn icon-btn" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
          <a class="btn" href="/">Graph</a>
          <button class="btn" id="refresh">Refresh</button>
        </header>
        <main>
          <div class="workspace">
            <section class="panel browser" aria-labelledby="existing-title">
              <div class="panel-head"><h2 id="existing-title">Existing tasks</h2><p>Select a task to inspect and control its runtime.</p></div>
              <div id="list" class="task-list">${this.renderTaskList()}</div>
              <div id="selection" class="selection">${e?this.renderSelection(e):$`<div class="message">${this.listError?"Task details unavailable.":"Select a task from the list."}</div>`}</div>
            </section>
            <section class="panel" aria-labelledby="create-title">
              <div class="panel-head"><h2 id="create-title">Create task</h2><p>Define a new board without leaving the task browser.</p></div>
              <div class="create-body">
                <div class="grid two">
                  <label>Task name<input id="name" placeholder="my-board" pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></label>
                  <label>Skills (comma-separated, optional)<input id="skills" placeholder="review, security"></label>
                  <label>Execution mode<select id="execution-mode"><option value="local">local</option><option value="docker">docker</option></select></label>
                  <label>Docker network mode (optional)<input id="network-mode" placeholder="bridge or host"></label>
                </div>
                <div class="grid" style="margin-top:12px">
                  <label>Projects (JSON array of {source, goal})<textarea id="projects" spellcheck="false" placeholder='[{"source":"Research inputs","goal":"research result"}]'></textarea></label>
                  <label>Workers (JSON array)<textarea id="workers" spellcheck="false" placeholder='[{"type":"pi","taskTypes":["plan","supervise","execute"],"maxRunning":1,"priority":1,"env":{}}]'></textarea></label>
                </div>
                <div class="form-actions">
                  <p class="form-note" id="form-note"></p>
                  <button id="create" class="btn primary">Create task</button>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    `}renderTaskList(){return this.listError?$`<div class="message error">${H(this.listError)}</div>`:this.tasks.length?$`
      ${this.tasks.map((e,t)=>{let n=!this.seenTasks.has(e.name);return this.seenTasks.add(e.name),$`
        <button
          type="button"
          class="task-option${n?" enter":""}${e.name===this.selectedName?" selected":""}"
          style=${n?`animation-delay:${Math.min(t,8)*45}ms`:""}
          aria-pressed="${e.name===this.selectedName}"
          @click=${()=>this.select(e.name)}
        >
          <div class="task-head"><strong>${H(e.name)}</strong><span class="badge ${e.status==="running"?"running":""}">${H(e.status)}</span></div>
          <div class="task-summary">${e.projects.length} project${e.projects.length===1?"":"s"}<code>${H(e.boardDir)}</code></div>
        </button>
      `})}
    `:$`<div class="message">No managed tasks yet.</div>`}renderSelection(e){let t=e.runtime?`${e.runtime.mode}${e.runtime.container?` \xB7 container ${e.runtime.container}`:e.runtime.pid?` \xB7 pid ${e.runtime.pid}`:""} \xB7 since ${e.runtime.startedAt??"?"}`:"not running",n=this.selectionShownFor!==e.name;return this.selectionShownFor=e.name,$`
      <div class=${n?"swap":""}>
      <h3>${H(e.name)}</h3>
      <div class="meta">${H(e.boardDir)} · ${H(t)}</div>
      <div class="projects">
        ${e.projects.length?e.projects.map(r=>$`<span class="badge" title=${H(`${r.title} \xB7 ${r.status}`)}>${H(`${r.title} \xB7 ${r.status}`)}</span>`):$`<span class="meta">No projects created yet</span>`}
      </div>
      <div class="actions">
        <a class="btn" href=${e.projects[0]?`/#${encodeURIComponent(e.projects[0].id)}`:"/"}>Graph view</a>
        <button class="btn" ?disabled=${e.status==="running"} @click=${()=>{this.start(e.name)}}>Start</button>
        <button class="btn" ?disabled=${e.status!=="running"} @click=${()=>{this.act(`${e.name}/stop`,"POST")}}>Stop</button>
        <button class="btn danger" @click=${()=>{this.removeTask(e.name)}}>Delete</button>
      </div>
      </div>
    `}firstUpdated(){let e=this.shadowRoot;e.querySelector("#theme").addEventListener("click",()=>X()),e.querySelector("#refresh").addEventListener("click",()=>{this.load()}),e.querySelector("#create").addEventListener("click",()=>{this.create()}),this.load(),this.pollTimer=window.setInterval(()=>{document.hidden||this.load()},5e3)}disconnectedCallback(){super.disconnectedCallback(),this.pollTimer!==null&&window.clearInterval(this.pollTimer)}select(e){this.selectedName=e,this.requestUpdate()}async load(){try{let e=await j("/api/tasks");this.tasks=e.tasks??[],this.tasks.some(t=>t.name===this.selectedName)||(this.selectedName=this.tasks[0]?.name??null),this.note=`${this.tasks.length} task${this.tasks.length===1?"":"s"}`,this.listError=""}catch(e){this.listError=e.message}this.requestUpdate()}async start(e){await this.act(`${e}/start`,"POST")}async act(e,t,n){try{await j(`/api/tasks/${e}`,{method:t,body:n}),await this.load()}catch(r){this.showFormNote(r.message,!0)}}async removeTask(e){if(!confirm(`Stop and delete task "${e}"? Project data is kept by default.`))return;let t=confirm("Also permanently delete this task's Project data (UUID directories)? This cannot be undone.");t&&!confirm(`Really purge ALL Project data of "${e}"?`)||await this.act(`${e}${t?"?purge=true":""}`,"DELETE")}async create(){let e=this.shadowRoot,t=r=>e.querySelector(r),n=t("#create");try{n.disabled=!0;let r=t("#name").value.trim(),s=JSON.parse(t("#projects").value),a=JSON.parse(t("#workers").value),o=t("#skills").value.split(",").map(p=>p.trim()).filter(Boolean),l=t("#execution-mode").value,c=t("#network-mode").value.trim(),d={mode:l,...c?{networkMode:c}:{}};await j("/api/tasks",{method:"POST",body:{name:r,projects:s,workers:a,execution:d,...o.length?{skills:o}:{}}}),this.selectedName=r,t("#name").value="",await this.load(),this.showFormNote(`Task "${r}" created`)}catch(r){this.showFormNote(r.message,!0)}finally{n.disabled=!1}}formNoteTimer=null;showFormNote(e,t=!1){let n=this.shadowRoot.querySelector("#form-note");n.textContent=e,n.style.color=t?"var(--rose)":"var(--teal)",this.formNoteTimer!==null&&window.clearTimeout(this.formNoteTimer),this.formNoteTimer=window.setTimeout(()=>{n.textContent=""},3500)}};customElements.define("peak-tasks",De);var Kt=U`
  :host { display: block; min-height: 100vh; min-height: 100dvh; background: var(--bg); }
  .shell { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: 58px minmax(0, 1fr); }
  @keyframes peak-bar-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-stage-in { from { opacity: 0; transform: translateY(12px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes peak-content-in { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: scale(1); } }
  @keyframes peak-pop-in { from { opacity: 0; transform: translateY(4px) scale(0.94); } to { opacity: 1; transform: translateY(0) scale(1); } }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 max(18px, env(safe-area-inset-right)) 0 max(18px, env(safe-area-inset-left));
    background: var(--glass);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 5;
    backdrop-filter: blur(14px) saturate(1.4);
    animation: peak-bar-in 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  header .mark {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-2));
    box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  header .mark svg { width: 15px; }
  header strong { font-size: 14.5px; letter-spacing: -0.01em; }
  header .meta {
    min-width: 0;
    color: var(--muted);
    font: 11px var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #download:not([hidden]) { animation: peak-pop-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .spacer { flex: 1; }

  .stage { min-height: 0; padding: 18px; display: grid; place-items: center; }
  .preview {
    width: 100%;
    height: 100%;
    min-height: calc(100vh - 94px);
    min-height: calc(100dvh - 94px);
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    overflow: auto;
    box-shadow: var(--shadow-md);
    animation: peak-stage-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.06s both;
  }
  .preview > * { animation: peak-content-in 0.4s ease both; }
  .preview img, .preview video { display: block; max-width: 100%; max-height: calc(100vh - 96px); max-height: calc(100dvh - 96px); }
  .preview audio { width: min(720px, 90%); }
  .preview iframe { width: 100%; height: 100%; min-height: calc(100vh - 94px); min-height: calc(100dvh - 94px); border: 0; }
  .preview pre {
    align-self: stretch;
    justify-self: stretch;
    margin: 0;
    padding: 20px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 12px/1.55 var(--mono);
    color: var(--ink-2);
  }
  @media (max-width: 640px) {
    header { gap: 8px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: 10px; }
    header strong { font-size: 13.5px; }
    header .meta { display: none; }
    .stage { padding: 8px; }
    .preview { border-radius: 12px; }
    .preview audio { width: 96%; }
    .preview pre { padding: 12px; font-size: 11px; }
  }
  @media (prefers-reduced-motion: reduce) {
    header, .preview, .preview > *, #download:not([hidden]) { animation: none !important; }
  }
`,Fe=class extends C{static styles=[J,Kt];meta="";error=!1;message="Loading artifact\u2026";messageDetail="";kind="loading";textBody="";objectUrl="";filename="";get params(){return new URLSearchParams(location.search)}render(){return $`
      <div class="shell">
        <header>
          <span class="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>
            </svg>
          </span>
          <strong>Artifact preview</strong>
          <span class="meta">${this.meta}</span>
          <span class="spacer"></span>
          <button class="btn icon-btn" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
          <a class="btn" href="/">Graph</a>
          <a id="download" class="btn primary" hidden>Download</a>
        </header>
        <main class="stage">
          <section class="preview">${this.renderContent()}</section>
        </main>
      </div>
    `}renderContent(){switch(this.kind){case"loading":return $`<div class="message"><strong>${this.message}</strong></div>`;case"none":return $`<div class="message${this.error?" error":""}"><strong>${this.message}</strong>${this.messageDetail}</div>`;case"image":return $`<img alt=${this.filename} src=${this.objectUrl}>`;case"audio":return $`<audio controls src=${this.objectUrl}></audio>`;case"video":return $`<video controls src=${this.objectUrl}></video>`;case"pdf":return $`<iframe title=${this.filename} src=${this.objectUrl}></iframe>`;case"html":return $`<iframe title=${this.filename} sandbox=""></iframe>`;case"text":return $`<pre>${this.textBody}</pre>`}}firstUpdated(){this.shadowRoot.querySelector("#theme").addEventListener("click",()=>X()),this.load(),window.addEventListener("pagehide",()=>{this.objectUrl&&URL.revokeObjectURL(this.objectUrl)})}showMessage(e,t="",n=!1){this.kind="none",this.message=e,this.messageDetail=t,this.error=n,this.requestUpdate()}textual(e){return e.startsWith("text/")||e.includes("json")||e.includes("xml")||e.includes("javascript")||e.includes("yaml")||e.includes("toml")||e.includes("markdown")}async load(){let e=this.params.get("project")??"",t=this.params.get("artifact")??"",n=this.params.get("filename")??t;if(this.filename=n,!e||!t){this.showMessage("Invalid preview link","Project and artifact identifiers are required.",!0);return}this.meta=t,this.kind="loading",this.requestUpdate();try{let r=await fetch(`/api/projects/${encodeURIComponent(e)}/artifacts/${encodeURIComponent(t)}`);if(!r.ok){let l=await r.text();try{l=JSON.parse(l).error??l}catch{}this.showMessage("Unable to preview artifact",l||`HTTP ${r.status}`,!0);return}let s=await r.blob(),a=(r.headers.get("content-type")||s.type||"application/octet-stream").split(";")[0].trim().toLowerCase();this.objectUrl&&URL.revokeObjectURL(this.objectUrl),this.objectUrl=URL.createObjectURL(s);let o=this.shadowRoot.querySelector("#download");if(o.href=this.objectUrl,o.download=n,o.hidden=!1,this.meta=`${n} \xB7 ${a} \xB7 ${s.size.toLocaleString()} bytes`,a.startsWith("image/"))this.kind="image";else if(a.startsWith("audio/"))this.kind="audio";else if(a.startsWith("video/"))this.kind="video";else if(a==="application/pdf")this.kind="pdf";else if(a==="text/html"||a==="application/xhtml+xml")this.kind="html";else if(this.textual(a)){let l=await s.text();if(a.includes("json"))try{l=JSON.stringify(JSON.parse(l),null,2)}catch{}this.textBody=l,this.kind="text"}else{this.showMessage("Preview is not available",`Use Download to open ${a} in a compatible application.`);return}if(this.requestUpdate(),this.kind==="html"){let l=this.shadowRoot.querySelector("iframe"),c=await s.text();l.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">${c}`}}catch(r){this.showMessage("Unable to preview artifact",r.message,!0)}}};customElements.define("peak-preview",Fe);pt();

!function(){let e;var o;let n;var s;(o=e||(e={})).UNKNOWN="unknown",o.SENT="sent",o.DELIVERED="delivered",o.READ="read",(s=n||(n={})).MSG="msg",s.CONNECTED="connected",s.DISCONNECTED="disconnected",s.ERROR="error",console.log("loaded");const t=new Map;function c(e){t.delete(e)}self.onconnect=e=>{console.log("onconnect");const o=e.ports[0];o.onmessage=e=>{const s=e.data;if(!s)throw new Error("no payload");switch(console.debug("onmessage",JSON.stringify(s)),s.type){case n.MSG:!function(e){t.forEach(((o,n)=>{if(n!=e.userId)try{o.postMessage(e)}catch(e){console.error(e),c(n)}}))}(s);break;case n.CONNECTED:!function(e,o){t.set(e,o),o.postMessage({type:n.CONNECTED,userId:e})}(s.userId,o);break;case n.DISCONNECTED:c(s.userId)}}}}();
//# sourceMappingURL=humane-worker.40689ad2.js.map
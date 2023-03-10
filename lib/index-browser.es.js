import EventEmitter from "events";
import immediate from "immediate";
import { Map } from "pouchdb-collections";
import { BAD_REQUEST, createError, INVALID_ID, MISSING_ID, RESERVED_ID } from "pouchdb-errors";
import { stringMd5 } from "pouchdb-md5";
import { assign } from "pouchdb-utils";
import { v4 } from "uuid";

function isBinaryObject(object) {
  return (typeof ArrayBuffer !== "undefined" && object instanceof ArrayBuffer) ||
    (typeof Blob !== "undefined" && object instanceof Blob);
}

function cloneArrayBuffer(buff) {
  if (typeof buff.slice === "function") {
    return buff.slice(0);
  }
  // IE10-11 slice() polyfill
  let target = new ArrayBuffer(buff.byteLength);
  let targetArray = new Uint8Array(target);
  let sourceArray = new Uint8Array(buff);
  targetArray.set(sourceArray);
  return target;
}

function cloneBinaryObject(object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object);
  }
  let size = object.size;
  let type = object.type;
  // Blob
  if (typeof object.slice === "function") {
    return object.slice(0, size, type);
  }
  // PhantomJS slice() replacement
  return object.webkitSlice(0, size, type);
}

// most of this is borrowed from lodash.isPlainObject:
// https://github.com/fis-components/lodash.isplainobject/
// blob/29c358140a74f252aeb08c9eb28bef86f2217d4a/index.js

let funcToString = Function.prototype.toString;
let objectCtorString = funcToString.call(Object);

function isPlainObject(value) {
  let proto = Object.getPrototypeOf(value);
  /* istanbul ignore if */
  if (proto === null) { // not sure when this happens, but I guess it can
    return true;
  }
  let Ctor = proto.constructor;
  return (typeof Ctor == "function" &&
    Ctor instanceof Ctor && funcToString.call(Ctor) == objectCtorString);
}

function clone(object) {
  let newObject;
  let i;
  let len;

  if (!object || typeof object !== "object") {
    return object;
  }

  if (Array.isArray(object)) {
    newObject = [];
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i]);
    }
    return newObject;
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date && isFinite(object)) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  if (!isPlainObject(object)) {
    return object; // don't clone objects like Workers
  }

  newObject = {};
  for (i in object) {
    /* istanbul ignore else */
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      let value = clone(object[i]);
      if (typeof value !== "undefined") {
        newObject[i] = value;
      }
    }
  }
  return newObject;
}

function once(fun) {
  let called = false;
  return function (...args) {
    /* istanbul ignore if */
    if (called) {
      // this is a smoke test and should never actually happen
      throw new Error("once called more than once");
    } else {
      called = true;
      fun.apply(this, args);
    }
  };
}

function toPromise(func) {
  //create the function we will be returning
  return async function (...args) {
    // Clone arguments
    args = clone(args);
    let self = this;
    // if the last argument is a function, assume its a callback
    let usedCB = (typeof args[args.length - 1] === "function") ? args.pop() : false;
    let promise = new Promise(function (fulfill, reject) {
      let resp;
      try {
        let callback = once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        resp = func.apply(self, args);
        if (resp && typeof resp.then === "function") {
          fulfill(resp);
        }
      } catch (e) {
        reject(e);
      }
    });
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(function (result) {
        usedCB(null, result);
      }, usedCB);
    }
    return promise;
  };
}

function logApiCall(self, name, args) {
  /* istanbul ignore if */
  if (self.constructor.listeners("debug").length) {
    let logArgs = ["api", self.name, name];
    for (let i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    self.constructor.emit("debug", logArgs);

    // override the callback itself to log the response
    let origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      let responseArgs = ["api", self.name, name];
      responseArgs = responseArgs.concat(
        err ? ["error", err] : ["success", res]
      );
      self.constructor.emit("debug", responseArgs);
      origCallback(err, res);
    };
  }
}

function adapterFun(name, callback) {
  return toPromise(function (...args) {
    if (this._closed) {
      return Promise.reject(new Error("database is closed"));
    }
    if (this._destroyed) {
      return Promise.reject(new Error("database is destroyed"));
    }
    let self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new Promise(function (fulfill, reject) {
        self.taskqueue.addTask(function (failed) {
          if (failed) {
            reject(failed);
          } else {
            fulfill(self[name].apply(self, args));
          }
        });
      });
    }
    return callback.apply(this, args);
  });
}

// like underscore/lodash _.pick()
function pick(obj, arr) {
  let res = {};
  for (let i = 0, len = arr.length; i < len; i++) {
    let prop = arr[i];
    if (prop in obj) {
      res[prop] = obj[prop];
    }
  }
  return res;
}

// Most browsers throttle concurrent requests at 6, so it's silly
// to shim _bulk_get by trying to launch potentially hundreds of requests
// and then letting the majority time out. We can handle this ourselves.
let MAX_NUM_CONCURRENT_REQUESTS = 6;

function identityFunction(x) {
  return x;
}

function formatResultForOpenRevsGet(result) {
  return [{
    ok: result,
  }];
}

// shim for P/CouchDB adapters that don't directly implement _bulk_get
function bulkGet(db, opts, callback) {
  let requests = opts.docs;

  // consolidate into one request per doc if possible
  let requestsById = new Map();
  requests.forEach(function (request) {
    if (requestsById.has(request.id)) {
      requestsById.get(request.id).push(request);
    } else {
      requestsById.set(request.id, [request]);
    }
  });

  let numDocs = requestsById.size;
  let numDone = 0;
  let perDocResults = new Array(numDocs);

  function collapseResultsAndFinish() {
    let results = [];
    perDocResults.forEach(function (res) {
      res.docs.forEach(function (info) {
        results.push({
          id: res.id,
          docs: [info],
        });
      });
    });
    callback(null, {results: results});
  }

  function checkDone() {
    if (++numDone === numDocs) {
      collapseResultsAndFinish();
    }
  }

  function gotResult(docIndex, id, docs) {
    perDocResults[docIndex] = {id: id, docs: docs};
    checkDone();
  }

  let allRequests = [];
  requestsById.forEach(function (value, key) {
    allRequests.push(key);
  });

  let i = 0;

  function nextBatch() {

    if (i >= allRequests.length) {
      return;
    }

    let upTo = Math.min(i + MAX_NUM_CONCURRENT_REQUESTS, allRequests.length);
    let batch = allRequests.slice(i, upTo);
    processBatch(batch, i);
    i += batch.length;
  }

  function processBatch(batch, offset) {
    batch.forEach(function (docId, j) {
      let docIdx = offset + j;
      let docRequests = requestsById.get(docId);

      // just use the first request as the "template"
      // TODO: The _bulk_get API allows for more subtle use cases than this,
      // but for now it is unlikely that there will be a mix of different
      // "atts_since" or "attachments" in the same request, since it's just
      // replicate.js that is using this for the moment.
      // Also, atts_since is aspirational, since we don't support it yet.
      let docOpts = pick(docRequests[0], ["atts_since", "attachments"]);
      docOpts.open_revs = docRequests.map(function (request) {
        // rev is optional, open_revs disallowed
        return request.rev;
      });

      // remove falsey / undefined revisions
      docOpts.open_revs = docOpts.open_revs.filter(identityFunction);

      let formatResult = identityFunction;

      if (docOpts.open_revs.length === 0) {
        delete docOpts.open_revs;

        // when fetching only the "winning" leaf,
        // transform the result so it looks like an open_revs
        // request
        formatResult = formatResultForOpenRevsGet;
      }

      // globally-supplied options
      ["revs", "attachments", "binary", "ajax", "latest"].forEach(function (param) {
        if (param in opts) {
          docOpts[param] = opts[param];
        }
      });
      db.get(docId, docOpts, function (err, res) {
        let result;
        /* istanbul ignore if */
        if (err) {
          result = [{error: err}];
        } else {
          result = formatResult(res);
        }
        gotResult(docIdx, docId, result);
        nextBatch();
      });
    });
  }

  nextBatch();

}

let hasLocal;

try {
  localStorage.setItem("_pouch_check_localstorage", 1);
  hasLocal = !!localStorage.getItem("_pouch_check_localstorage");
} catch (e) {
  hasLocal = false;
}

function hasLocalStorage() {
  return hasLocal;
}

// Custom nextTick() shim for browsers. In node, this will just be process.nextTick(). We

class Changes extends EventEmitter {
  constructor() {
    super();

    this._listeners = {};

    if (hasLocalStorage()) {
      addEventListener("storage", (e) => {
        this.emit(e.key);
      });
    }
  }

  addListener(dbName, id, db, opts) {
    if (this._listeners[id]) {
      return;
    }
    let inprogress = false;
    let self = this;
    function eventFunction() {
      if (!self._listeners[id]) {
        return;
      }
      if (inprogress) {
        inprogress = "waiting";
        return;
      }
      inprogress = true;
      let changesOpts = pick(opts, [
        "style", "include_docs", "attachments", "conflicts", "filter",
        "doc_ids", "view", "since", "query_params", "binary", "return_docs",
      ]);

      function onError() {
        inprogress = false;
      }

      db.changes(changesOpts).on("change", function (c) {
        if (c.seq > opts.since && !opts.cancelled) {
          opts.since = c.seq;
          opts.onChange(c);
        }
      }).on("complete", function () {
        if (inprogress === "waiting") {
          immediate(eventFunction);
        }
        inprogress = false;
      }).on("error", onError);
    }
    this._listeners[id] = eventFunction;
    this.on(dbName, eventFunction);
  }

  removeListener(dbName, id) {
    if (!(id in this._listeners)) {
      return;
    }
    super.removeListener(dbName, this._listeners[id]);
    delete this._listeners[id];
  }

  notifyLocalWindows(dbName) {
    //do a useless change on a storage thing
    //in order to get other windows's listeners to activate
    if (hasLocalStorage()) {
      localStorage[dbName] = (localStorage[dbName] === "a") ? "b" : "a";
    }
  }

  notify(dbName) {
    this.emit(dbName);
    this.notifyLocalWindows(dbName);
  }
}

function guardedConsole(method) {
  /* istanbul ignore else */
  if (typeof console !== "undefined" && typeof console[method] === "function") {
    let args = Array.prototype.slice.call(arguments, 1);
    console[method].apply(console, args);
  }
}

function randomNumber(min, max) {
  let maxTimeout = 600000; // Hard-coded default of 10 minutes
  min = parseInt(min, 10) || 0;
  max = parseInt(max, 10);
  if (max !== max || max <= min) {
    max = (min || 1) << 1; //doubling
  } else {
    max = max + 1;
  }
  // In order to not exceed maxTimeout, pick a random value between half of maxTimeout and maxTimeout
  if (max > maxTimeout) {
    min = maxTimeout >> 1; // divide by two
    max = maxTimeout;
  }
  let ratio = Math.random();
  let range = max - min;

  return ~~(range * ratio + min); // ~~ coerces to an int, but fast.
}

function defaultBackOff(min) {
  let max = 0;
  if (!min) {
    max = 2000;
  }
  return randomNumber(min, max);
}

// designed to give info to browser users, who are disturbed
// when they see http errors in the console
function explainError(status, str) {
  guardedConsole("info", `The above ${  status  } is totally normal. ${  str}`);
}

let assign$1;
{
  if (typeof Object.assign === "function") {
    assign$1 = Object.assign;
  } else {
    // lite Object.assign polyfill based on
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign
    assign$1 = function (target) {
      let to = Object(target);

      for (let index = 1; index < arguments.length; index++) {
        let nextSource = arguments[index];

        if (nextSource != null) { // Skip over if undefined or null
          for (let nextKey in nextSource) {
            // Avoid bugs when hasOwnProperty is shadowed
            if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
              to[nextKey] = nextSource[nextKey];
            }
          }
        }
      }
      return to;
    };
  }
}

let assign$2 = assign$1;

function tryFilter(filter, doc, req) {
  try {
    return !filter(doc, req);
  } catch (err) {
    let msg = `Filter function threw: ${  err.toString()}`;
    return createError(BAD_REQUEST, msg);
  }
}

function filterChange(opts) {
  let req = {};
  let hasFilter = opts.filter && typeof opts.filter === "function";
  req.query = opts.query_params;

  return function filter(change) {
    if (!change.doc) {
      // CSG sends events on the changes feed that don't have documents,
      // this hack makes a whole lot of existing code robust.
      change.doc = {};
    }

    let filterReturn = hasFilter && tryFilter(opts.filter, change.doc, req);

    if (typeof filterReturn === "object") {
      return filterReturn;
    }

    if (filterReturn) {
      return false;
    }

    if (!opts.include_docs) {
      delete change.doc;
    } else if (!opts.attachments) {
      for (let att in change.doc._attachments) {
        /* istanbul ignore else */
        if (Object.prototype.hasOwnProperty.call(change.doc._attachments, att)) {
          change.doc._attachments[att].stub = true;
        }
      }
    }
    return true;
  };
}

function flatten(arrs) {
  let res = [];
  for (let i = 0, len = arrs.length; i < len; i++) {
    res = res.concat(arrs[i]);
  }
  return res;
}

// shim for Function.prototype.name,
// for browsers that don't support it like IE

/* istanbul ignore next */
function f() {}

let hasName = f.name;
let res;

// We dont run coverage in IE
/* istanbul ignore else */
if (hasName) {
  res = function (fun) {
    return fun.name;
  };
} else {
  res = function (fun) {
    let match = fun.toString().match(/^\s*function\s*(?:(\S+)\s*)?\(/);
    if (match && match[1]) {
      return match[1];
    } else {
      return "";
    }
  };
}

let res$1 = res;

// Determine id an ID is valid
//   - invalid IDs begin with an underescore that does not begin '_design' or
//     '_local'
//   - any other string value is a valid id
// Returns the specific error object for each case
function invalidIdError(id) {
  let err;
  if (!id) {
    err = createError(MISSING_ID);
  } else if (typeof id !== "string") {
    err = createError(INVALID_ID);
  } else if (/^_/.test(id) && !(/^_(design|local)/).test(id)) {
    err = createError(RESERVED_ID);
  }
  if (err) {
    throw err;
  }
}

// Checks if a PouchDB object is "remote" or not. This is

function isRemote(db) {
  if (typeof db._remote === "boolean") {
    return db._remote;
  }
  /* istanbul ignore next */
  if (typeof db.type === "function") {
    guardedConsole("warn",
                   "db.type() is deprecated and will be removed in " +
      "a future version of PouchDB");
    return db.type() === "http";
  }
  /* istanbul ignore next */
  return false;
}

function listenerCount(ee, type) {
  return "listenerCount" in ee ? ee.listenerCount(type) :
    EventEmitter.listenerCount(ee, type);
}

function parseDesignDocFunctionName(s) {
  if (!s) {
    return null;
  }
  let parts = s.split("/");
  if (parts.length === 2) {
    return parts;
  }
  if (parts.length === 1) {
    return [s, s];
  }
  return null;
}

function normalizeDesignDocFunctionName(s) {
  let normalized = parseDesignDocFunctionName(s);
  return normalized ? normalized.join("/") : null;
}

// originally parseUri 1.2.2, now patched by us
// (c) Steven Levithan <stevenlevithan.com>
// MIT License
let keys = ["source", "protocol", "authority", "userInfo", "user", "password",
  "host", "port", "relative", "path", "directory", "file", "query", "anchor"];
let qName ="queryKey";
let qParser = /(?:^|&)([^&=]*)=?([^&]*)/g;

// use the "loose" parser
/* eslint no-useless-escape: 0 */
let parser = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;

function parseUri(str) {
  let m = parser.exec(str);
  let uri = {};
  let i = 14;

  while (i--) {
    let key = keys[i];
    let value = m[i] || "";
    let encoded = ["user", "password"].indexOf(key) !== -1;
    uri[key] = encoded ? decodeURIComponent(value) : value;
  }

  uri[qName] = {};
  uri[keys[12]].replace(qParser, function ($0, $1, $2) {
    if ($1) {
      uri[qName][$1] = $2;
    }
  });

  return uri;
}

// Based on https://github.com/alexdavid/scope-eval v0.0.3
// (source: https://unpkg.com/scope-eval@0.0.3/scope_eval.js)
// This is basically just a wrapper around new Function()

function scopeEval(source, scope) {
  let keys = [];
  let values = [];
  for (let key in scope) {
    if (Object.prototype.hasOwnProperty.call(scope, key)) {
      keys.push(key);
      values.push(scope[key]);
    }
  }
  keys.push(source);
  return Function.apply(null, keys).apply(null, values);
}

// this is essentially the "update sugar" function from daleharvey/pouchdb#1388
// the diffFun tells us what delta to apply to the doc.  it either returns
// the doc, or false if it doesn't need to do an update after all
function upsert(db, docId, diffFun) {
  return db.get(docId)
    .catch(function (err) {
      /* istanbul ignore next */
      if (err.status !== 404) {
        throw err;
      }
      return {};
    })
    .then(function (doc) {
      // the user might change the _rev, so save it for posterity
      let docRev = doc._rev;
      let newDoc = diffFun(doc);

      if (!newDoc) {
        // if the diffFun returns falsy, we short-circuit as
        // an optimization
        return {updated: false, rev: docRev};
      }

      // users aren't allowed to modify these values,
      // so reset them here
      newDoc._id = docId;
      newDoc._rev = docRev;
      return tryAndPut(db, newDoc, diffFun);
    });
}

function tryAndPut(db, doc, diffFun) {
  return db.put(doc).then(function (res) {
    return {
      updated: true,
      rev: res.rev,
    };
  }, function (err) {
    /* istanbul ignore next */
    if (err.status !== 409) {
      throw err;
    }
    return upsert(db, doc._id, diffFun);
  });
}

/**
 * Creates a new revision string that does NOT include the revision height
 * For example '56649f1b0506c6ca9fda0746eb0cacdf'
 */
function rev(doc, deterministic_revs) {
  if (!deterministic_revs) {
    return v4().replace(/-/g, "").toLowerCase();
  }

  let mutateableDoc = assign({}, doc);
  delete mutateableDoc._rev_tree;
  return stringMd5(JSON.stringify(mutateableDoc));
}

let uuid = v4; // mimic old import, only v4 is ever used elsewhere

export { adapterFun, assign$2 as assign, bulkGet as bulkGetShim, Changes as changesHandler, clone, defaultBackOff, explainError, filterChange, flatten, res$1 as functionName, guardedConsole, hasLocalStorage, invalidIdError, isRemote, listenerCount, immediate as nextTick, normalizeDesignDocFunctionName as normalizeDdocFunctionName, once, parseDesignDocFunctionName as parseDdocFunctionName, parseUri, pick, rev, scopeEval, toPromise, upsert, uuid };

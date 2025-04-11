// @ts-nocheck
const CHATGPT_NEXT_WEB_CACHE = "chatgpt-next-web-cache";
const CHATGPT_NEXT_WEB_FILE_CACHE = "chatgpt-next-web-file";
let a="useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";let nanoid=(e=21)=>{let t="",r=crypto.getRandomValues(new Uint8Array(e));for(let n=0;n<e;n++)t+=a[63&r[n]];return t};

self.addEventListener("activate", function (event) {
  console.log("ServiceWorker activated.");
});

self.addEventListener("install", function (event) {
  self.skipWaiting();  // enable new version
  event.waitUntil(
    caches.open(CHATGPT_NEXT_WEB_CACHE).then(function (cache) {
      // 你可以在这里预缓存任何静态资源，如果需要的话
      // 例如 return cache.addAll(['/index.html', '/style.css']);
      return cache.addAll([]); // 保持为空，如果不需要预缓存
    }),
  );
});

// 辅助函数，用于创建 JSON 响应
function jsonify(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'content-type': 'application/json' }
  });
}

// 处理文件上传的函数
async function upload(request, url) {
  try { // <--- 添加 try 块
    const formData = await request.formData();
    const file = formData.getAll('file')[0];

    if (!file) {
      console.error("Service Worker: No file found in formData.");
      return jsonify({ error: 'No file uploaded' }, 400); // 返回客户端错误
    }

    let ext = file.name.split('.').pop();
    if (ext === 'blob' || !ext) { // 处理没有扩展名或扩展名为 blob 的情况
      const typeExt = file.type.split('/').pop();
      ext = typeExt || 'bin'; // 如果类型也没有提供后缀，默认为 bin
    }

    const fileUrl = `${url.origin}/api/cache/${nanoid()}.${ext}`;
    console.log(`Service Worker: Generated file URL: ${fileUrl}`);

    const cache = await caches.open(CHATGPT_NEXT_WEB_FILE_CACHE);
    console.log(`Service Worker: Opened cache: ${CHATGPT_NEXT_WEB_FILE_CACHE}`);

    // 创建用于缓存的 Response 对象
    const responseToCache = new Response(file, {
      headers: {
        'content-type': file.type || 'application/octet-stream', // 提供默认 content-type
        'content-length': file.size.toString(),
        'cache-control': 'no-cache', // 文件已在磁盘中，缓存控制设为 no-cache
        'server': 'ServiceWorker',
      }
    });

    await cache.put(new Request(fileUrl), responseToCache);
    console.log(`Service Worker: Successfully cached file: ${fileUrl}`);

    // 返回包含文件 URL 的成功 JSON 响应
    return jsonify({ code: 0, data: fileUrl });

  } catch (error) { // <--- 添加 catch 块
    console.error("Service Worker upload error:", error);
    // 返回一个明确的错误响应给前端
    return jsonify({
      error: 'Service Worker upload failed',
      details: error.message || 'Unknown error'
    }, 500); // 使用 500 Internal Server Error
  }
}

// 处理文件删除的函数
async function remove(request, url) {
  try { // <--- 添加 try 块
    const cache = await caches.open(CHATGPT_NEXT_WEB_FILE_CACHE);
    console.log(`Service Worker: Attempting to delete cache for: ${request.url}`);
    const res = await cache.delete(request.url); // 使用完整的请求 URL 作为 key
    if (res) {
      console.log(`Service Worker: Successfully deleted cache for: ${request.url}`);
      return jsonify({ code: 0, message: 'File deleted successfully' });
    } else {
      console.warn(`Service Worker: Cache not found for deletion: ${request.url}`);
      return jsonify({ code: 1, message: 'File not found in cache' }, 404); // 返回 404 Not Found
    }
  } catch (error) { // <--- 添加 catch 块
    console.error("Service Worker remove error:", error);
    return jsonify({
      error: 'Service Worker remove failed',
      details: error.message || 'Unknown error'
    }, 500);
  }
}

// fetch 事件监听器，拦截网络请求
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 只处理 /api/cache/ 路径下的请求
  if (/^\/api\/cache\//.test(url.pathname)) { // 确保匹配 /api/cache/ 开头的路径
    console.log(`Service Worker: Intercepting fetch for: ${e.request.method} ${e.request.url}`);

    if (e.request.method === 'GET') {
      e.respondWith(
        caches.match(e.request).then(response => {
          if (response) {
            console.log(`Service Worker: Serving from cache: ${e.request.url}`);
            return response;
          }
          console.warn(`Service Worker: Cache miss for: ${e.request.url}`);
          // 如果缓存未命中，可以选择返回 404 或尝试网络请求（如果适用）
          return new Response('File not found in Service Worker cache', { status: 404 });
        }).catch(error => {
          console.error("Service Worker GET error:", error);
          return jsonify({ error: 'Service Worker GET failed', details: error.message }, 500);
        })
      );
    } else if (e.request.method === 'POST') {
      // 调用 upload 函数处理 POST 请求
      e.respondWith(upload(e.request, url));
    } else if (e.request.method === 'DELETE') {
      // 调用 remove 函数处理 DELETE 请求
      e.respondWith(remove(e.request, url));
    } else {
      // 对于 /api/cache/ 下不支持的方法，返回 405
      console.warn(`Service Worker: Method not allowed for ${e.request.url}: ${e.request.method}`);
      e.respondWith(new Response('Method Not Allowed', { status: 405 }));
    }
  }
  // 对于非 /api/cache/ 的请求，不进行拦截，让它们正常发送到网络
});

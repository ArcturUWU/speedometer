"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  const el = Object.fromEntries([
    "cockpit", "speed-value", "speed-caption", "request-count", "gear-status", "status-text",
    "total-value", "average-value", "byte-rate-value", "test-form", "target-url", "start-button",
    "cancel-button", "demo-button", "demo-badge", "request-chart", "request-table", "results-subtitle",
    "success-text", "export-button", "error-banner", "error-text", "retry-button", "connection-pill",
    "connection-text", "result-announcement", "gauge-svg", "gauge-needle", "gauge-fill", "gauge-ticks",
    "gauge-labels", "session-time", "live-data", "progress-label", "progress-bar", "run-progress",
    "endpoint-name", "result-speed", "result-unit", "result-state", "result-date", "chart-line",
    "chart-area", "chart-empty", "chart-ymax", "chart-duration", "result-source", "chart-markers",
    "metric-success", "run-label", "test-size", "copy-button",
  ].map((id) => [id, $(id)]));
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const decimal = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  const requests = new Set();
  let generation = 0;
  let timer = null;
  let animation = null;
  let shownSpeed = 0;
  let shownAngle = 135;
  let targetSpeed = 0;
  let scale = 300;
  let token = "";
  let online = false;
  let mode = "real";
  let actionPending = false;
  let cancelRequested = false;
  let offline = false;
  let state = readyState();
  let announcedStatus = "";
  let tableSignature = "";
  let finishedKey = "";
  let finishedAt = null;
  let firstPoll = true;

  const text = (id, value) => { if (el[id]) el[id].textContent = value; };
  const number = (value) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };
  const seconds = (value) => `${String(Math.floor(number(value) / 60)).padStart(2, "0")}:${String(Math.floor(number(value) % 60)).padStart(2, "0")}`;
  const hostname = (url) => { try { return new URL(url).hostname || "Демонстрация"; } catch { return "Выберите сервер"; } };
  const label = (id, value) => {
    const button = el[id];
    if (!button) return;
    if (button.firstElementChild?.tagName === "SPAN") button.firstElementChild.textContent = value;
    else {
      const node = Array.from(button.childNodes).find((child) => child.nodeType === Node.TEXT_NODE);
      if (node) node.textContent = `${value} `;
      else button.prepend(document.createTextNode(`${value} `));
    }
  };

  function readyState() {
    return {
      status: "ready", index: 0, live_mbps: 0, samples: [], trace: [], elapsed_s: 0, downloaded_bytes: 0,
      stats: { successful: 0, failed: 0, total_bytes: 0, total_seconds: 0, avg_seconds: 0, mbps: 0, MBps: 0 }, error: null,
    };
  }
  function clearTimer() { if (timer !== null) window.clearTimeout(timer); timer = null; }
  function nextGeneration() {
    clearTimer();
    generation += 1;
    for (const controller of requests) controller.abort();
    requests.clear();
    return generation;
  }
  function setConnection(connected) {
    online = connected;
    offline = !connected;
    el["connection-pill"]?.classList.toggle("online", connected);
    el["connection-pill"]?.classList.toggle("offline", !connected);
    text("connection-text", connected ? "Сервер подключён" : "Нет соединения");
  }
  function displayError(message, reconnect = false) {
    text("error-text", message);
    el["error-banner"].hidden = false;
    el["retry-button"].hidden = !reconnect;
  }
  function clearError() { el["error-banner"].hidden = true; text("error-text", ""); }
  function humanError(message) {
    const value = String(message || "Не удалось выполнить запрос.");
    if (/request exceeded its time limit/i.test(value)) return "Загрузка заняла больше 15 секунд. Выберите файл поменьше или другой сервер.";
    if (/connection failed:/i.test(value)) return "Не удалось загрузить файл. Проверьте интернет и адрес сервера.";
    if (/url must not include a username or password/i.test(value)) return "Нужна публичная ссылка без логина и пароля в адресе.";
    if (/spaces or control characters/i.test(value)) return "Уберите пробелы и переносы строк из адреса файла.";
    if (/response exceeds.*size limit/i.test(value)) return "Файл больше 100 МБ. Выберите файл меньшего размера.";
    if (/incomplete response/i.test(value)) return "Сервер прервал загрузку. Полученный файл неполный.";
    if (/response body is empty/i.test(value)) return "Сервер вернул пустой файл. Выберите другую ссылку.";
    if (/too many redirects/i.test(value)) return "Слишком много перенаправлений. Вставьте прямую ссылку на файл.";
    if (/content-length/i.test(value)) return "Сервер передал некорректный размер файла. Выберите другую ссылку.";
    if (/^cancelled\.?$/i.test(value)) return "Запрос остановлен";
    if (/failed to fetch|networkerror|abort|timed out|timeout/i.test(value)) return "Сервер не отвечает. Проверьте соединение и повторите попытку.";
    if (/only.*https?|http.*https.*only|unsupported.*scheme|complete.*https?/i.test(value)) return "Нужен полный адрес, начинающийся с https:// или http://.";
    if (/invalid.*url|url.*invalid|hostname|port could|port out|ipv6|url.*required|missing.*url/i.test(value)) return "Проверьте адрес: нужна прямая ссылка на доступный файл.";
    if (/already.*running|test.*running/i.test(value)) return "Тест уже идёт. Дождитесь завершения или остановите его.";
    if (/token|forbidden|csrf|reload the local dashboard/i.test(value)) return "Сессия обновилась. Нажмите «Переподключить» и запустите тест снова.";
    const http = value.match(/HTTP(?: error)?\s*(\d{3})/i);
    if (http) return http[1] === "404" ? "Файл не найден (HTTP 404). Проверьте ссылку." : http[1] === "403" ? "Сервер запретил загрузку (HTTP 403). Выберите другой адрес." : `Сервер ответил ошибкой HTTP ${http[1]}. Выберите другой адрес.`;
    if (/open the printed 127|invalid request|expected application|expected a json/i.test(value)) return "Перезагрузите страницу по локальному адресу из окна запуска.";
    return value;
  }

  async function request(path, body) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST", cache: "no-store", signal: controller.signal,
        headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Speedometer-Token": token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload;
      try { payload = await response.json(); } catch { throw new Error("Локальный сервер вернул некорректный ответ. Перезапустите приложение."); }
      if (!response.ok) { const error = new Error(payload.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
      return payload;
    } finally { window.clearTimeout(timeout); requests.delete(controller); }
  }

  function svgElement(name, attributes) {
    const node = document.createElementNS(svgNS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }
  function point(angle, radius) {
    const radians = angle * Math.PI / 180;
    return [300 + Math.cos(radians) * radius, 270 + Math.sin(radians) * radius];
  }
  function drawScale() {
    if (el["gauge-ticks"] && !el["gauge-ticks"].children.length) {
      for (let i = 0; i <= 60; i += 1) {
        const major = i % 10 === 0;
        const [x1, y1] = point(135 + i * 4.5, major ? 204 : 214);
        const [x2, y2] = point(135 + i * 4.5, 222);
        el["gauge-ticks"].append(svgElement("line", { x1, y1, x2, y2, class: major ? "tick tick-major" : "tick" }));
      }
    }
    if (el["gauge-labels"]) {
      el["gauge-labels"].replaceChildren(...Array.from({ length: 7 }, (_, i) => {
        const [x, y] = point(135 + i * 45, 186);
        const node = svgElement("text", { x, y, "text-anchor": "middle", "dominant-baseline": "central" });
        node.textContent = String(Math.round(scale * i / 6));
        return node;
      }));
    }
  }
  function paintSpeed(speed, angle) {
    const [whole, fraction] = number(speed).toFixed(1).split(".");
    const decimalPart = document.createElement("span"); decimalPart.textContent = `.${fraction}`;
    el["speed-value"].replaceChildren(document.createTextNode(whole), decimalPart);
    el["gauge-needle"]?.setAttribute("transform", `rotate(${angle.toFixed(3)} 300 270)`);
    el["gauge-fill"]?.setAttribute("stroke-dasharray", `${Math.max(0, Math.min(100, (angle - 135) / 270 * 100)).toFixed(3)} 100`);
  }
  function stopAnimation() {
    if (animation !== null) window.cancelAnimationFrame(animation);
    animation = null;
  }
  function animateSpeed(speed, immediate = false) {
    targetSpeed = number(speed);
    let expanded = false;
    while (targetSpeed > scale) { scale *= 2; expanded = true; }
    if (expanded) drawScale();
    const targetAngle = 135 + Math.min(1, targetSpeed / scale) * 270;
    el["gauge-svg"]?.setAttribute("aria-label", `${compact.format(targetSpeed)} мегабит в секунду${mode === "demo" ? ", демонстрация" : ""}`);
    if (motionPreference.matches || immediate) {
      stopAnimation(); shownSpeed = targetSpeed; shownAngle = targetAngle; paintSpeed(shownSpeed, shownAngle); return;
    }
    if (animation !== null) return;
    let previous = performance.now();
    function frame(now) {
      const blend = 1 - Math.exp(-Math.min(64, now - previous) / 145);
      previous = now;
      const angle = 135 + Math.min(1, targetSpeed / scale) * 270;
      shownSpeed += (targetSpeed - shownSpeed) * blend;
      shownAngle += (angle - shownAngle) * blend;
      if (Math.abs(targetSpeed - shownSpeed) < .025 && Math.abs(angle - shownAngle) < .015) {
        shownSpeed = targetSpeed; shownAngle = angle; paintSpeed(shownSpeed, shownAngle); animation = null; return;
      }
      paintSpeed(shownSpeed, shownAngle);
      animation = window.requestAnimationFrame(frame);
    }
    animation = window.requestAnimationFrame(frame);
  }
  function resetGauge() { scale = 300; drawScale(); animateSpeed(0, true); }
  motionPreference.addEventListener?.("change", () => animateSpeed(targetSpeed, true));

  if (el["run-progress"] && !el["run-progress"].children.length) {
    for (let i = 0; i < 10; i += 1) {
      const segment = document.createElement("span"); segment.setAttribute("aria-hidden", "true"); el["run-progress"].append(segment);
    }
  }
  function renderSamples(samples) {
    const signature = JSON.stringify(samples);
    if (signature === tableSignature) return;
    tableSignature = signature;
    const rows = samples.map((sample, i) => {
      const row = document.createElement("tr"); row.className = sample.error ? "row-error" : "row-ok";
      const values = [String(sample.index || i + 1).padStart(2, "0"), decimal.format(number(sample.bytes) / 1e6), decimal.format(number(sample.elapsed_s)), sample.error ? "—" : decimal.format(number(sample.mbps)), sample.error ? humanError(sample.error) : "Завершён"];
      values.forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); });
      return row;
    });
    if (!rows.length) {
      const row = document.createElement("tr"); const cell = document.createElement("td");
      cell.colSpan = 5; cell.textContent = "После старта здесь появятся 10 последовательных загрузок."; row.append(cell); rows.push(row);
    }
    el["request-table"]?.replaceChildren(...rows);
  }
  function renderChart(next) {
    if (!el["chart-line"]) return;
    let points = Array.isArray(next.trace) ? next.trace.filter((p) => Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.mbps)) && p.t >= 0 && p.mbps >= 0) : [];
    if (!points.length) {
      let elapsed = 0;
      points = (next.samples || []).flatMap((sample) => {
        elapsed += number(sample.elapsed_s);
        return sample.error ? [] : [{ t: elapsed, mbps: number(sample.mbps) }];
      });
    }
    const duration = Math.max(number(next.elapsed_s), ...points.map((p) => number(p.t)), 0);
    const ymax = points.length ? Math.max(50, Math.ceil(Math.max(...points.map((p) => number(p.mbps))) / 50) * 50) : 300;
    const coordinates = points.map((p) => [12 + number(p.t) / Math.max(.1, duration) * 976, 165 - number(p.mbps) / ymax * 150]);
    const path = coordinates.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
    el["chart-line"].setAttribute("d", path);
    if (el["chart-area"]) el["chart-area"].setAttribute("d", coordinates.length > 1 ? `${path} L${coordinates.at(-1)[0].toFixed(2)} 165 L${coordinates[0][0].toFixed(2)} 165 Z` : "");
    if (el["chart-markers"]) {
      const last = coordinates.at(-1);
      el["chart-markers"].replaceChildren(...(last ? [svgElement("circle", { cx: last[0], cy: last[1], r: 3.5, class: "trace-marker" })] : []));
    }
    if (el["chart-empty"]) {
      el["chart-empty"].hidden = points.length > 0;
      text("chart-empty", next.status === "ready" ? "ЗАПУСТИ ТЕСТ, ЧТОБЫ УВИДЕТЬ ПРОФИЛЬ СКОРОСТИ" : next.status === "running" ? "ОЖИДАНИЕ ДАННЫХ" : "НЕТ ДАННЫХ ДЛЯ ГРАФИКА");
    }
    text("chart-ymax", `${compact.format(ymax)} Мбит/с`);
    text("chart-duration", `${compact.format(duration)} с`);
    el["request-chart"]?.setAttribute("aria-label", points.length ? `${mode === "demo" ? "Демонстрация. " : ""}Скорость загрузки: ${points.length} измерений за ${compact.format(duration)} секунд; максимум ${compact.format(Math.max(...points.map((p) => number(p.mbps))))} мегабит в секунду.` : next.status === "ready" ? "График скорости. Ожидание измерения." : next.status === "running" ? "График скорости. Ожидание данных." : "График скорости. Нет данных для графика.");
  }
  function render(next, restored = false) {
    const oldStatus = state.status;
    state = next;
    const stats = next.stats || readyState().stats;
    const samples = Array.isArray(next.samples) ? next.samples : [];
    const running = next.status === "running";
    const count = Math.min(10, samples.length);
    const demo = mode === "demo";
    if (running && !demo && next.url && el["target-url"].value !== next.url) {
      el["target-url"].value = next.url;
      if (el["test-size"]) {
        el["test-size"].value = next.url === "https://speed.cloudflare.com/__down?bytes=5000000" ? "5" : next.url === "https://speed.cloudflare.com/__down?bytes=20000000" ? "20" : "custom";
      }
    }
    const speed = running ? number(next.live_mbps) : number(stats.mbps);
    const ready = next.status === "ready";
    const successful = number(stats.successful);
    const downloaded = next.downloaded_bytes == null ? number(stats.total_bytes) : number(next.downloaded_bytes);
    el["cockpit"]?.classList.toggle("running", running && (demo || !offline));
    el["demo-badge"].hidden = !demo;
    animateSpeed(speed, ready);
    if (!ready && !running && !successful) el["gauge-svg"]?.setAttribute("aria-label", "Скорость не измерена.");
    text("request-count", String(count).padStart(2, "0"));
    text("total-value", decimal.format(number(stats.total_bytes) / 1e6));
    text("average-value", decimal.format(number(stats.avg_seconds)));
    text("byte-rate-value", decimal.format(number(stats.MBps)));
    text("session-time", seconds(next.elapsed_s));
    text("live-data", decimal.format(downloaded / 1e6));
    text("progress-label", `${String(count).padStart(2, "0")} / 10`);
    text("metric-success", `${successful} / 10`);
    text("results-subtitle", `${count} из 10 загрузок${demo ? " · ДЕМО" : ""}`);
    text("endpoint-name", demo ? "DEMO · без загрузок" : hostname(running ? next.url : el["target-url"].value));
    text("result-speed", ready || !successful ? "—" : compact.format(number(stats.mbps)));
    text("result-unit", demo ? "Мбит/с · ДЕМО" : "Мбит/с");
    text("result-source", demo ? "Синтетические данные · не измерение интернета" : next.url && !ready ? next.url : "Результат появится после первого теста");
    if (el["progress-bar"]) el["progress-bar"].style.width = `${count * 10}%`;
    if (el["run-progress"]) Array.from(el["run-progress"].children).forEach((segment, i) => {
      segment.classList.toggle("done", i < count);
      segment.classList.toggle("failed", Boolean(samples[i]?.error));
      segment.classList.toggle("active", running && (demo || !offline) && i === count && !cancelRequested);
    });
    el["target-url"].disabled = running || actionPending;
    if (el["test-size"]) el["test-size"].disabled = running || actionPending;
    el["start-button"].hidden = running;
    el["cancel-button"].hidden = !running;
    el["start-button"].disabled = actionPending || !online || !token;
    el["cancel-button"].disabled = actionPending || cancelRequested || (offline && !demo);
    label("start-button", actionPending && !running ? "Запускаем…" : "Начать тест");
    label("cancel-button", cancelRequested ? "Останавливаем…" : "Остановить");
    el["demo-button"].disabled = running || actionPending;
    el["export-button"].disabled = !samples.length || running;
    if (el["copy-button"]) el["copy-button"].disabled = !samples.length || running;
    el["test-form"].setAttribute("aria-busy", String(actionPending || running));
    text("success-text", samples.length ? `${successful} успешно${stats.failed ? ` · ${stats.failed} с ошибкой` : ""}` : "Ожидание первого запроса");
    let gear = "READY";
    let caption = "Готов к измерению";
    let status = online ? "Соединение готово. Можно начинать." : "Подключение к локальному серверу…";
    let resultStatus = "Ожидание теста";
    if (running) {
      gear = cancelRequested ? "STOPPING" : "MEASURING";
      caption = demo ? "Демонстрация анимации" : "Текущая скорость загрузки";
      status = cancelRequested ? "Останавливаем текущую загрузку…" : `Загрузка ${String(Math.min(10, count + 1)).padStart(2, "0")} из 10${demo ? " · вымышленные данные" : " · один поток"}`;
      resultStatus = "Измерение идёт";
    } else if (next.status === "completed") {
      gear = "COMPLETE"; caption = "Средняя скорость загрузки";
      status = demo ? "Демо завершено. Данные вымышленные." : "10 загрузок завершены. Результат готов.";
      resultStatus = "Измерение завершено";
    } else if (next.status === "cancelled") {
      gear = "STOPPED"; caption = "Среднее по успешным загрузкам";
      status = `Тест остановлен. ${successful} из 10 загрузок завершено.`; resultStatus = "Тест остановлен";
    } else if (next.status === "partial") {
      gear = "PARTIAL"; caption = successful ? "Среднее по успешным загрузкам" : "Не удалось измерить скорость";
      status = successful ? "Часть загрузок завершилась с ошибкой." : "Загрузки не удались. Проверьте адрес файла.";
      resultStatus = successful ? "Частичный результат" : "Нет успешных загрузок";
    } else if (next.status === "error") {
      gear = "ERROR"; caption = "Не удалось измерить скорость"; status = "Проверьте адрес и повторите попытку."; resultStatus = "Ошибка измерения";
    }
    if (offline && running && !demo) {
      gear = "OFFLINE"; caption = "Последнее полученное измерение"; status = "Связь с сервером потеряна. Результат ещё не подтверждён."; resultStatus = "Ожидание соединения";
    }
    text("gear-status", demo ? `DEMO / ${gear}` : gear);
    text("speed-caption", demo && !running ? `ДЕМО · ${caption.toLowerCase()}` : caption);
    text("status-text", status); text("run-label", status);
    text("result-state", demo ? `ДЕМО · ${resultStatus.toLowerCase()}` : resultStatus);
    const key = `${mode}:${next.id || generation}:${next.status}`;
    if (!running && !ready && key !== finishedKey) { finishedKey = key; finishedAt = restored ? null : new Date(); }
    if (ready || running) text("result-date", running ? "Текущая сессия" : "—");
    else text("result-date", finishedAt ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }).format(finishedAt) : "Последний результат сервера");
    if (next.error) displayError(humanError(next.error));
    else if (next.status === "partial") displayError(successful ? "Результат рассчитан по успешным загрузкам. Причины ошибок — в таблице запросов." : humanError(samples.find((sample) => sample.error)?.error));
    renderSamples(samples); renderChart(next);
    if (!running && !ready && announcedStatus !== key) {
      announcedStatus = key;
      const measurement = successful ? `Средняя скорость ${decimal.format(number(stats.mbps))} мегабит в секунду.` : "Скорость не измерена.";
      text("result-announcement", `${demo ? "Демонстрация. " : ""}${status} ${measurement}`);
    } else if (running && oldStatus !== "running") text("result-announcement", demo ? "Запущена демонстрация. Все данные вымышленные." : "Измерение началось. Десять последовательных загрузок.");
  }

  async function poll(myGeneration) {
    try {
      const next = await request("/api/status");
      if (myGeneration !== generation || mode !== "real") return;
      token = next.token || token; setConnection(true); clearError();
      if (next.status !== "running") cancelRequested = false;
      const restored = firstPoll; firstPoll = false;
      render(next, restored);
      if (next.status === "running") timer = window.setTimeout(() => poll(myGeneration), 100);
    } catch (error) {
      if (myGeneration !== generation || mode !== "real") return;
      setConnection(false); actionPending = false; cancelRequested = false;
      render(state); stopAnimation();
      displayError("Локальный сервер недоступен. Оставьте окно запуска открытым и нажмите «Переподключить».", true);
    }
  }
  el["test-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (actionPending || state.status === "running" || !online || !token) return;
    const url = el["target-url"].value.trim();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || /[\s\x00-\x1f\x7f]/.test(url)) throw new Error("invalid");
    } catch { displayError("Вставьте прямую ссылку на файл: https:// или http://, без пробелов, логина и пароля."); el["target-url"].focus(); return; }
    const myGeneration = nextGeneration();
    mode = "real"; actionPending = true; cancelRequested = false; finishedAt = null; clearError(); resetGauge(); render(readyState());
    try {
      const next = await request("/api/start", { url });
      if (myGeneration !== generation) return;
      token = next.token || token; setConnection(true); actionPending = false; render(next);
      if (next.status === "running") timer = window.setTimeout(() => poll(myGeneration), 100);
    } catch (error) {
      if (myGeneration !== generation) return;
      actionPending = false;
      if (!error.status || error.status === 409) {
        // A timed-out POST may still have started the server job. Reconcile it
        // before allowing another start; a stale response cannot revive a run.
        await poll(myGeneration);
        if (myGeneration === generation && online && state.status === "ready") displayError(humanError(error.message));
      } else { render(state); displayError(humanError(error.message), error.status === 403); }
    }
  });
  el["cancel-button"].addEventListener("click", async () => {
    if (actionPending || cancelRequested || state.status !== "running") return;
    const myGeneration = nextGeneration();
    if (mode === "demo") { cancelRequested = false; render({ ...state, status: "cancelled" }); return; }
    cancelRequested = true; actionPending = true; render(state);
    try {
      const next = await request("/api/cancel", {});
      if (myGeneration !== generation) return;
      actionPending = false; if (next.status !== "running") cancelRequested = false;
      render(next);
      if (next.status === "running") timer = window.setTimeout(() => poll(myGeneration), 100);
    } catch (error) {
      if (myGeneration !== generation) return;
      actionPending = false; cancelRequested = false;
      await poll(myGeneration);
      if (myGeneration === generation && online && state.status === "running") displayError("Не удалось подтвердить остановку. Нажмите «Остановить» ещё раз.");
    }
  });
  el["demo-button"].addEventListener("click", () => {
    if (actionPending || state.status === "running") return;
    const myGeneration = nextGeneration();
    mode = "demo"; cancelRequested = false; actionPending = false; clearError(); resetGauge();
    const demoState = { ...readyState(), id: `demo-${Date.now()}`, status: "running", url: "demo://synthetic-data", mode: "demo" };
    const began = performance.now();
    let previous = 0;
    let requestBytes = 0;
    render(demoState);
    function demoStep() {
      if (myGeneration !== generation || mode !== "demo") return;
      const elapsed = Math.min(12, (performance.now() - began) / 1000);
      const speed = (1 - Math.exp(-elapsed / .42)) * (143 + 32 * Math.sin(elapsed * 1.2) + 18 * Math.sin(elapsed * 2.7) + 14 * (1 - Math.exp(-elapsed / 3)));
      // Explicit simulation: integrate the displayed synthetic rate into bytes
      // so its summary remains internally consistent at every frame.
      let cursor = previous;
      while (cursor < elapsed && demoState.samples.length < 10) {
        const boundary = (demoState.samples.length + 1) * 1.2;
        const end = Math.min(elapsed, boundary);
        requestBytes += (end - cursor) * speed * 1e6 / 8;
        cursor = end;
        if (end >= boundary - .000001) {
          const bytes = Math.round(requestBytes);
          const mbps = bytes * 8 / 1e6 / 1.2;
          demoState.samples.push({ index: demoState.samples.length + 1, bytes, elapsed_s: 1.2, mbps, MBps: mbps / 8, error: null });
          requestBytes = 0;
        }
      }
      previous = elapsed;
      demoState.elapsed_s = elapsed; demoState.live_mbps = speed; demoState.current_bytes = Math.round(requestBytes);
      demoState.current_elapsed_s = elapsed - demoState.samples.length * 1.2;
      demoState.index = Math.min(10, demoState.samples.length + 1);
      demoState.trace.push({ t: elapsed, mbps: speed });
      const total_bytes = demoState.samples.reduce((sum, sample) => sum + sample.bytes, 0);
      const total_seconds = demoState.samples.length * 1.2;
      const mbps = total_seconds ? total_bytes * 8 / 1e6 / total_seconds : 0;
      demoState.downloaded_bytes = total_bytes + Math.round(requestBytes);
      demoState.stats = { successful: demoState.samples.length, failed: 0, total_bytes, total_seconds, avg_seconds: total_seconds ? 1.2 : 0, mbps, MBps: mbps / 8 };
      if (elapsed >= 12) demoState.status = "completed";
      render(demoState);
      if (demoState.status === "running") timer = window.setTimeout(demoStep, 100);
    }
    timer = window.setTimeout(demoStep, 100);
  });
  el["retry-button"].addEventListener("click", () => {
    const myGeneration = nextGeneration(); mode = "real"; actionPending = false; cancelRequested = false; clearError();
    text("connection-text", "Подключение…"); poll(myGeneration);
  });
  el["test-size"]?.addEventListener("change", () => {
    const size = el["test-size"].value;
    if (size !== "custom") {
      const bytes = ["20", "20MB", "20000000"].includes(size) ? 20000000 : 5000000;
      el["target-url"].value = `https://speed.cloudflare.com/__down?bytes=${bytes}`;
      text("endpoint-name", "speed.cloudflare.com");
    } else el["target-url"].focus();
  });
  el["target-url"].addEventListener("input", () => {
    if (el["test-size"]) el["test-size"].value = "custom";
    text("endpoint-name", hostname(el["target-url"].value));
  });
  function exportResult() {
    const result = { ...state, mode: mode === "demo" ? "demo_synthetic_not_an_internet_measurement" : "real_download", exported_at: new Date().toISOString() };
    delete result.token;
    return JSON.stringify(result, null, 2);
  }
  el["export-button"].addEventListener("click", () => {
    if (!state.samples?.length || state.status === "running") return;
    try {
      const blob = new Blob([exportResult()], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url;
      link.download = `speedometer-${mode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      text("result-announcement", "Результат сохранён в JSON.");
    } catch { displayError("Не удалось сохранить файл. Скопируйте результат кнопкой «Копировать»."); }
  });
  el["copy-button"]?.addEventListener("click", async () => {
    if (!state.samples?.length || state.status === "running") return;
    try {
      await navigator.clipboard.writeText(exportResult());
      text("result-announcement", "Результат скопирован."); label("copy-button", "Скопировано");
      window.setTimeout(() => label("copy-button", "Копировать результат"), 1800);
    } catch { displayError("Браузер не разрешил копирование. Сохраните результат кнопкой JSON."); }
  });
  window.addEventListener("pagehide", () => { nextGeneration(); stopAnimation(); });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    actionPending = false;
    if (mode === "real") poll(generation);
    else if (state.status === "running") render({ ...state, status: "cancelled" });
    else animateSpeed(targetSpeed, true);
  });
  drawScale(); render(state); poll(generation);
})();

const ROLES = ["탑", "정글", "미드", "원딜", "서폿"];
const ROLE_SHORT = { "탑": "TOP", "정글": "JGL", "미드": "MID", "원딜": "ADC", "서폿": "SUP" };
const TIER_SCORE = {
  "챌린저": 100, "그랜드마스터": 94, "마스터": 88, "다이아몬드": 78,
  "에메랄드": 68, "플래티넘": 58, "골드": 48, "실버": 38, "브론즈": 28, "아이언": 18,
};
const GRADE_SCORE = { "장인": 10, "잘함": 7, "보통": 4, "가능": 1 };
const DRAFT_STEPS = [
  ["blue", "ban"], ["red", "ban"], ["blue", "ban"], ["red", "ban"], ["blue", "ban"], ["red", "ban"],
  ["blue", "pick"], ["red", "pick"], ["red", "pick"], ["blue", "pick"], ["blue", "pick"], ["red", "pick"],
  ["red", "ban"], ["blue", "ban"], ["red", "ban"], ["blue", "ban"],
  ["red", "pick"], ["blue", "pick"], ["blue", "pick"], ["red", "pick"],
].map(([side, type], index) => ({ side, type, index }));

const state = {
  data: null,
  selected: JSON.parse(localStorage.getItem("inhouse:selected") || "[]"),
  roleFilter: "전체",
  rosterQuery: "",
  playerQuery: "",
  teams: null,
  mySide: "blue",
  championImages: new Map(),
  championNames: [],
  encryptedPayload: null,
  draftActions: [],
  draftCandidates: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const percent = (value) => `${Math.round(Number(value || 0) * 100)}%`;
const compact = (value) => Number(value || 0).toFixed(2).replace(/\.00$/, "");
const displayPlayerName = (player) => player.displayName || player.name;

function saveSelection() {
  localStorage.setItem("inhouse:selected", JSON.stringify(state.selected));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function tierScore(player) {
  const tier = `${player.currentTier} ${player.peakTier}`;
  const key = Object.keys(TIER_SCORE).find((name) => tier.includes(name));
  const base = key ? TIER_SCORE[key] : 45;
  const gamesWeight = Math.min(1, player.games / 10);
  const contextualWin = 50 + ((player.winRate * 100) - 50) * gamesWeight * .45;
  const kdaValue = Math.min(5, player.kda) * 2.6;
  return Math.round(base * .66 + contextualWin * .22 + kdaValue * .12);
}

function roleFit(player, role) {
  if (player.roleLock && role !== player.roleLock) return 0;
  if (player.manualRolesOnly) {
    if (!player.manualRoles?.includes(role)) return 0;
    const roleRecord = player.roles.find((item) => item.role === role);
    return 120 + Math.min(18, Number(roleRecord?.games || 0) * 2) + Number(player.rolePreference?.[role] || 0);
  }
  let score = 8;
  if (player.manualRoles?.includes(role)) score += 76;
  if (player.primaryRole === role) score += 92;
  if (player.secondaryRole?.includes(role)) score += 64;
  const roleRecord = player.roles.find((item) => item.role === role);
  if (roleRecord) {
    const declared = player.primaryRole === role || player.secondaryRole?.includes(role);
    score += declared ? Math.min(32, roleRecord.games * 6) : 52 + Math.min(20, roleRecord.games * 4);
  }
  return score;
}

function eligibleRoles(player) {
  if (player.roleLock) return [player.roleLock];
  if (player.manualRolesOnly) return [...player.manualRoles];
  const roles = new Set([player.primaryRole, ...(player.manualRoles || [])]);
  ROLES.forEach((role) => {
    if (player.secondaryRole?.includes(role) || player.roles.some((item) => item.role === role && item.games > 0)) roles.add(role);
  });
  return [...roles];
}

function secondaryRoleLabel(player) {
  const secondary = eligibleRoles(player).filter((role) => role !== player.primaryRole);
  return secondary.length ? secondary.join(" · ") : "없음";
}

function isOffRole(player, role) {
  return roleFit(player, role) < 55;
}

function assignedPower(player, role) {
  return Math.round(Number(player.rolePower?.[role] ?? tierScore(player)));
}

function preferredTeammatePenalty(blue, red) {
  const all = [...Object.values(blue), ...Object.values(red)];
  return [blue, red].reduce((penalty, team) => {
    const members = Object.values(team);
    return penalty + members.reduce((memberPenalty, player) => memberPenalty + (player.preferredTeammates || []).reduce((sum, preferredName) => {
      const preferred = all.find((candidate) => candidate.name.startsWith(preferredName));
      return sum + Number(preferred && !members.includes(preferred)) * 8;
    }, 0), 0);
  }, 0);
}

function playerById(id) {
  return state.data.players.find((player) => player.id === id);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function decryptData(payload, password) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromBase64(payload.salt), iterations: payload.iterations, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(payload.iv), tagLength: 128 },
    key,
    fromBase64(payload.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

function calibratePoolGrades(player) {
  const totalEffectiveGames = player.pool.reduce((sum, item) => sum + Number(item.effectiveGames || 0), 0);
  const artisanRank = ["챌린저", "그랜드마스터", "마스터", "다이아몬드", "에메랄드"]
    .some((tier) => `${player.currentTier} ${player.peakTier}`.includes(tier));
  player.pool.forEach((item) => {
    const mastery = Number(item.masteryScore || 0);
    const effectiveGames = Number(item.effectiveGames || 0);
    const internalGames = Number(item.internalGames || 0);
    const poolShare = totalEffectiveGames ? effectiveGames / totalEffectiveGames : 0;

    if (artisanRank && effectiveGames >= 25 && mastery >= 74 && (poolShare >= .58 || (mastery >= 92 && internalGames >= 2))) {
      item.grade = "장인";
    } else if ((mastery >= 80 && effectiveGames >= 18) || (mastery >= 72 && effectiveGames >= 35)) {
      item.grade = "잘함";
    } else if ((mastery >= 56 && effectiveGames >= 8) || (internalGames >= 2 && mastery >= 48)) {
      item.grade = "보통";
    } else {
      item.grade = "가능";
    }
  });
}

function applyLoadedData(data) {
  if (!data?.meta || !Array.isArray(data.players) || !Array.isArray(data.games)) throw new Error("올바른 내전 데이터가 아닙니다.");
  data.players.forEach(calibratePoolGrades);
  state.data = data;
  state.selected = state.selected.filter((id) => state.data.players.some((player) => player.id === id)).slice(0, 10);
  $("#data-date").textContent = state.data.meta.dataDate;
  renderEverything();
  loadChampionImages();
}

async function unlockRemoteData(password) {
  const data = await decryptData(state.encryptedPayload, password);
  applyLoadedData(data);
  sessionStorage.setItem("inhouse:unlock", password);
  $("#unlock-error").textContent = "";
  $("#unlock-dialog").close();
}

function championPortrait(name, size = 28) {
  const url = state.championImages.get(name);
  return `<span class="champ-portrait" style="width:${size}px;height:${size}px" title="${escapeHtml(name)}">${url ? `<img src="${url}" alt="${escapeHtml(name)}" loading="lazy">` : escapeHtml(name.slice(0, 1))}</span>`;
}

async function loadChampionImages() {
  try {
    const realm = await fetch("https://ddragon.leagueoflegends.com/realms/kr.json").then((response) => response.json());
    const catalog = await fetch(`https://ddragon.leagueoflegends.com/cdn/${realm.v}/data/ko_KR/champion.json`).then((response) => response.json());
    state.championNames = Object.values(catalog.data).map((champion) => champion.name).sort((a, b) => a.localeCompare(b, "ko"));
    Object.values(catalog.data).forEach((champion) => {
      state.championImages.set(champion.name, `https://ddragon.leagueoflegends.com/cdn/${realm.v}/img/champion/${champion.image.full}`);
    });
    renderEverything();
  } catch (error) {
    console.warn("Champion portraits unavailable", error);
  }
}

function renderRoleFilters() {
  $("#role-filters").innerHTML = ["전체", ...ROLES].map((role) => `
    <button class="role-filter ${state.roleFilter === role ? "is-active" : ""}" data-role-filter="${role}" aria-pressed="${state.roleFilter === role}">${role}</button>
  `).join("");
}

function searchableText(player) {
  return [player.name, displayPlayerName(player), player.riotId, player.primaryRole, player.secondaryRole, ...player.championRecords.map((record) => record.champion), ...player.pool.map((item) => item.champion)].join(" ").toLowerCase();
}

function renderRoster() {
  const query = state.rosterQuery.trim().toLowerCase();
  const visible = state.data.players.filter((player) => {
    const roleMatch = state.roleFilter === "전체" || eligibleRoles(player).includes(state.roleFilter);
    return roleMatch && (!query || searchableText(player).includes(query));
  });
  $("#selected-count").textContent = state.selected.length;
  $("#roster-list").innerHTML = visible.length ? visible.map((player) => {
    const selected = state.selected.includes(player.id);
    const disabled = state.selected.length >= 10 && !selected;
    return `<button class="roster-row ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}" data-player-select="${player.id}" ${disabled ? "disabled" : ""}>
      <span class="roster-name">
        <span class="role-glyph" data-role="${player.primaryRole}">${ROLE_SHORT[player.primaryRole] || "ALL"}</span>
        <span class="roster-copy"><strong>${escapeHtml(displayPlayerName(player))}</strong><small>${escapeHtml(player.currentTier)} · ${player.games}경기</small></span>
      </span>
      <span class="selection-box">✓</span>
    </button>`;
  }).join("") : `<div class="empty-insight"><strong>검색 결과가 없습니다.</strong><p>이름이나 라인 필터를 바꿔보세요.</p></div>`;
}

function renderSelectedStage() {
  const balanceButton = $("#balance-teams");
  balanceButton.disabled = state.selected.length !== 10;
  if (state.teams) {
    $("#selected-stage").hidden = true;
    $("#team-board").hidden = false;
    $("#workspace-status").textContent = "라인별 두 선수를 교체하거나 밴픽 준비를 확인하세요.";
    renderTeams();
    return;
  }
  $("#selected-stage").hidden = false;
  $("#team-board").hidden = true;
  $("#workspace-status").textContent = state.selected.length === 10 ? "10명이 모였습니다. 자동 균형 편성을 실행하세요." : `선택한 참가자 ${state.selected.length}명 · ${10 - state.selected.length}명 남음`;
  if (!state.selected.length) {
    $("#selected-stage").innerHTML = `<div class="empty-state"><div class="empty-lines" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><strong>아직 선택한 참가자가 없습니다.</strong><p>최근 10명을 불러오거나 참가자 풀에서 직접 선택할 수 있습니다.</p></div>`;
    return;
  }
  $("#selected-stage").innerHTML = `<div class="selection-summary"><p>선수 정보는 참가자 이름을 눌러 자세히 볼 수 있습니다.</p><div class="selected-grid">${state.selected.map((id, index) => {
    const player = playerById(id);
    return `<div class="selected-strip"><span class="strip-index">${String(index + 1).padStart(2, "0")}</span><span class="roster-copy" data-player-detail="${player.id}" role="button" tabindex="0"><strong>${escapeHtml(displayPlayerName(player))}</strong><small>${escapeHtml(player.primaryRole)} · ${escapeHtml(player.currentTier)}</small></span><button data-remove-player="${player.id}" aria-label="${escapeHtml(displayPlayerName(player))} 선택 해제">제거</button></div>`;
  }).join("")}</div></div>`;
}

function bestRoleAssignment(players) {
  const slots = ROLES.flatMap((role) => [role, role]).sort((a, b) => {
    const aOptions = players.filter((player) => roleFit(player, a) >= 55).length;
    const bOptions = players.filter((player) => roleFit(player, b) >= 55).length;
    return aOptions - bOptions;
  });
  const memo = new Map();
  function solve(index, mask) {
    if (index === slots.length) return { score: 0, assignments: [] };
    const key = `${index}:${mask}`;
    if (memo.has(key)) return memo.get(key);
    const role = slots[index];
    let best = null;
    players.forEach((player, playerIndex) => {
      if (mask & (1 << playerIndex)) return;
      const fit = roleFit(player, role);
      if (fit <= 0) return;
      const next = solve(index + 1, mask | (1 << playerIndex));
      if (!next) return;
      const candidate = { score: fit + next.score, assignments: [{ role, player }, ...next.assignments] };
      if (!best || candidate.score > best.score) best = candidate;
    });
    memo.set(key, best);
    return best;
  }
  return solve(0, 0);
}

function createBalancedTeams() {
  if (state.selected.length !== 10) return;
  const assignment = bestRoleAssignment(state.selected.map(playerById));
  if (!assignment) return showToast("현재 참가자 조합으로 라인을 편성할 수 없습니다.");
  const rolePairs = Object.fromEntries(ROLES.map((role) => [role, []]));
  assignment.assignments.forEach(({ role, player }) => rolePairs[role].push(player));

  let best = null;
  for (let mask = 0; mask < 32; mask += 1) {
    const blue = {}, red = {};
    ROLES.forEach((role, index) => {
      const pair = rolePairs[role];
      const flip = (mask >> index) & 1;
      blue[role] = pair[flip];
      red[role] = pair[1 - flip];
    });
    const laneGaps = ROLES.map((role) => Math.abs(assignedPower(blue[role], role) - assignedPower(red[role], role)));
    const bluePower = ROLES.reduce((sum, role) => sum + assignedPower(blue[role], role), 0);
    const redPower = ROLES.reduce((sum, role) => sum + assignedPower(red[role], role), 0);
    const totalGap = Math.abs(bluePower - redPower);
    const maxLaneGap = Math.max(...laneGaps);
    const laneGapCost = laneGaps.reduce((sum, gap) => sum + gap * 1.35 + Math.max(0, gap - 6) * 2.8, 0);
    const offRoles = ROLES.reduce((sum, role) => sum + Number(isOffRole(blue[role], role)) + Number(isOffRole(red[role], role)), 0);
    const blueCallers = ROLES.filter((role) => blue[role].shotCaller).length;
    const redCallers = ROLES.filter((role) => red[role].shotCaller).length;
    const callerGap = Math.abs(blueCallers - redCallers);
    const peerMatchBonus = ROLES.reduce((sum, role) => {
      const group = blue[role].balanceGroup;
      return sum + Number(group && group === red[role].balanceGroup) * 10;
    }, 0);
    const teammatePenalty = preferredTeammatePenalty(blue, red);
    const cost = totalGap * .45 + laneGapCost + maxLaneGap * 1.2 + offRoles * 16 + callerGap * 14 + teammatePenalty - peerMatchBonus;
    if (!best || cost < best.cost) best = { blue, red, cost, laneGaps, maxLaneGap, callerGap };
  }
  state.teams = { blue: best.blue, red: best.red };
  state.draftActions = [];
  renderEverything();
  showToast("라인별 전력 차이와 오더 분배까지 계산해 편성했습니다.");
}

function renderLineup(team) {
  return ROLES.map((role) => {
    const player = state.teams[team][role];
    const offRole = isOffRole(player, role);
    const topChamps = player.championRecords.filter((record) => record.role === role).slice(0, 3);
    const fallback = player.pool.filter((item) => item.role?.includes(role)).slice(0, 3);
    const champs = (topChamps.length ? topChamps.map((item) => item.champion) : fallback.map((item) => item.champion)).slice(0, 3);
    return `<div class="lineup-slot ${offRole ? "is-offrole" : ""}" data-team="${team}" data-role="${role}">
      <span class="slot-role">${role}</span>
      <div class="slot-player" data-player-detail="${player.id}" role="button" tabindex="0">
        <strong>${escapeHtml(displayPlayerName(player))}</strong>
        <small class="${offRole ? "offrole-note" : ""}">${offRole ? "라인 이탈 · " : ""}${escapeHtml(player.currentTier)} · ${player.games}경기</small>
        <div class="slot-champs">${champs.map((champion) => championPortrait(champion)).join("")}</div>
      </div>
    </div>`;
  }).join("");
}

function teamPower(team) {
  return ROLES.reduce((sum, role) => sum + assignedPower(state.teams[team][role], role), 0);
}

function renderTeams() {
  $("#blue-lineup").innerHTML = renderLineup("blue");
  $("#red-lineup").innerHTML = renderLineup("red");
  const blue = teamPower("blue");
  const red = teamPower("red");
  $("#blue-power").textContent = `전력 ${blue}`;
  $("#red-power").textContent = `전력 ${red}`;
  $("#swap-rail").innerHTML = ROLES.map((role) => `<button class="swap-button" data-swap-role="${role}" title="${role} 선수 교체" aria-label="${role} 선수 교체">↔</button>`).join("");
}

function candidateScore(player, item, mode = "pick", role = player.primaryRole) {
  const internal = player.championRecords.filter((record) => record.champion === item.champion);
  const internalGames = internal.reduce((sum, record) => sum + record.games, 0);
  const internalWins = internal.reduce((sum, record) => sum + record.wins, 0);
  const repeated = Math.min(36, internalGames * 13);
  const success = internalGames ? (internalWins / internalGames) * 12 : 4;
  const mastery = Math.min(36, (item.masteryScore || 0) * .42);
  const roleMatch = item.role?.includes(player.primaryRole) ? 8 : 0;
  const playerStrength = assignedPower(player, role);
  const tierThreat = mode === "ban" ? clamp((playerStrength - 50) * 1.5, -8, 20) : clamp((playerStrength - 45) * .18, -2, 5);
  return Math.round(repeated + success + mastery + roleMatch + tierThreat);
}

function teamCandidates(team, limit = 5, mode = "pick") {
  const all = [];
  ROLES.forEach((role) => {
    const player = state.teams[team][role];
    const merged = new Map();
    player.pool.slice(0, 12).forEach((item) => merged.set(item.champion, item));
    player.championRecords.slice(0, 8).forEach((record) => {
      if (!merged.has(record.champion)) merged.set(record.champion, { champion: record.champion, role: record.role, masteryScore: 38, grade: record.sample, internalGames: record.games });
    });
    merged.forEach((item) => all.push({ ...item, player, score: candidateScore(player, item, mode, role), role }));
  });
  const unique = new Map();
  all.sort((a, b) => b.score - a.score).forEach((item) => {
    if (!unique.has(item.champion)) unique.set(item.champion, item);
  });
  return [...unique.values()].slice(0, limit);
}

function renderFocusRows(items) {
  return items.map((item) => {
    const internal = item.player.championRecords.filter((record) => record.champion === item.champion).reduce((sum, record) => sum + record.games, 0);
    const reason = internal >= 2 ? `${item.player.name.split(" (")[0]} · 내전 ${internal}경기` : `${item.player.name.split(" (")[0]} · ${item.grade || "숙련 기록"}`;
    return `<div class="focus-row">${championPortrait(item.champion, 34)}<span class="focus-copy"><strong>${escapeHtml(item.champion)}</strong><small>${escapeHtml(reason)}</small></span><span class="focus-score">${item.score}</span></div>`;
  }).join("");
}

function renderInsights() {
  if (!state.teams) {
    $("#insight-content").innerHTML = `<div class="empty-insight"><strong>팀 편성이 필요합니다.</strong><p>두 팀이 완성되면 전력 차이, 라인 이탈, 상대 반복 픽을 한곳에서 확인할 수 있습니다.</p></div>`;
    return;
  }
  const bluePower = teamPower("blue");
  const redPower = teamPower("red");
  const total = bluePower + redPower;
  const blueShare = Math.round((bluePower / total) * 100);
  const offRoles = ROLES.flatMap((role) => [
    isOffRole(state.teams.blue[role], role) ? `블루 ${role}: ${state.teams.blue[role].name}` : null,
    isOffRole(state.teams.red[role], role) ? `레드 ${role}: ${state.teams.red[role].name}` : null,
  ]).filter(Boolean);
  const opponent = state.mySide === "blue" ? "red" : "blue";
  const bans = teamCandidates(opponent, 5, "ban");
  const comforts = teamCandidates(state.mySide, 5, "pick");
  $("#insight-content").innerHTML = `
    <div>
      <div class="balance-readout"><div><strong>팀 균형</strong><span>차이 ${Math.abs(bluePower - redPower)}점</span></div><div class="balance-bar" style="--blue-share:${blueShare}%"><i></i></div>
        ${offRoles.length ? `<ul class="warning-list">${offRoles.map((item) => `<li>${escapeHtml(item)} 라인 이탈</li>`).join("")}</ul>` : `<ul class="warning-list"><li>모든 선수가 확인된 라인에 배치됐습니다.</li></ul>`}
      </div>
      <div class="draft-side-toggle"><button class="side-button ${state.mySide === "blue" ? "is-active" : ""}" data-side="blue">내 팀 블루</button><button class="side-button ${state.mySide === "red" ? "is-active" : ""}" data-side="red">내 팀 레드</button></div>
    </div>
    <div class="focus-block"><h3>상대 견제 우선순위</h3><p>반복 사용·숙련 기록·배치 라인을 합산한 참고값입니다.</p><div class="focus-list">${renderFocusRows(bans)}</div></div>
    <div class="focus-block"><h3>우리 팀 중심축</h3><p>실제 내전 반복 사용을 먼저 보고 장기 숙련으로 보완합니다.</p><div class="focus-list">${renderFocusRows(comforts)}</div></div>
    <button class="primary-button open-draft-button" data-open-draft><i data-lucide="swords" aria-hidden="true"></i>밴픽 도우미 열기</button>`;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function roleMatches(value, role) {
  return String(value || "").split(/[·,/\s]+/).includes(role);
}

function draftCurrentStep() {
  return DRAFT_STEPS[state.draftActions.length] || null;
}

function draftActions(side, type) {
  return state.draftActions.filter((action) => action.side === side && action.type === type);
}

function draftPickedRoles(side) {
  return new Set(draftActions(side, "pick").map((action) => action.role));
}

function draftAvailableRoles(side) {
  const filled = draftPickedRoles(side);
  return ROLES.filter((role) => !filled.has(role));
}

function knownChampionNames() {
  if (state.championNames.length) return state.championNames;
  return [...new Set(state.data.players.flatMap((player) => [
    ...player.pool.map((item) => item.champion),
    ...player.championRecords.map((item) => item.champion),
  ]))].sort((a, b) => a.localeCompare(b, "ko"));
}

function roleCandidateEntries(player, role, mode) {
  const merged = new Map();
  player.pool.forEach((item, rank) => {
    if (!roleMatches(item.role, role)) return;
    merged.set(item.champion, { champion: item.champion, pool: item, rank });
  });
  player.championRecords.forEach((record) => {
    if (record.role !== role) return;
    const current = merged.get(record.champion) || { champion: record.champion, pool: null, rank: 18 };
    current.record = record;
    merged.set(record.champion, current);
  });

  return [...merged.values()].map((entry) => {
    const records = player.championRecords.filter((record) => record.champion === entry.champion && record.role === role);
    const internalGames = records.reduce((sum, record) => sum + record.games, 0);
    const internalWins = records.reduce((sum, record) => sum + record.wins, 0);
    const mastery = Number(entry.pool?.masteryScore || (internalGames ? 54 : 36));
    const adjustedWinRate = (internalWins + 1.5) / (internalGames + 3);
    const confidence = 1 - Math.exp(-internalGames / 2.25);
    const declared = player.primaryRole === role ? 7 : player.secondaryRole?.includes(role) ? 4 : 1;
    const grade = GRADE_SCORE[entry.pool?.grade] || 0;
    const rankValue = Math.max(0, 6 - entry.rank * .5);
    const targetValue = mode === "ban" ? Math.min(7, internalGames * 1.5) : 0;
    const playerStrength = assignedPower(player, role);
    const tierThreat = mode === "ban" ? clamp((playerStrength - 50) * 1.5, -8, 20) : clamp((playerStrength - 45) * .16, -2, 4);
    const score = clamp(Math.round(
      24 + mastery * .24 + confidence * 11 + (adjustedWinRate - .5) * 12
        + declared + grade * .8 + rankValue + targetValue + tierThreat
    ), 42, 96);
    return {
      champion: entry.champion,
      player,
      role,
      score,
      internalGames,
      adjustedWinRate,
      mastery,
      playerStrength,
      tierThreat,
      grade: entry.pool?.grade || (internalGames ? "내전 기록" : "가능"),
    };
  });
}

function draftRecommendations(limit = 7) {
  const step = draftCurrentStep();
  if (!step || !state.teams) return [];
  const sourceSide = step.type === "ban" ? (step.side === "blue" ? "red" : "blue") : step.side;
  const roles = draftAvailableRoles(sourceSide);
  const used = new Set(state.draftActions.map((action) => action.champion));
  const candidates = roles.flatMap((role) => roleCandidateEntries(state.teams[sourceSide][role], role, step.type))
    .filter((item) => !used.has(item.champion));
  const unique = new Map();
  candidates.sort((a, b) => b.score - a.score).forEach((item) => {
    if (!unique.has(item.champion)) unique.set(item.champion, item);
  });

  if (unique.size < limit) {
    const fallback = roles.flatMap((role) => {
      const player = state.teams[sourceSide][role];
      const pool = new Map();
      state.data.players.forEach((source) => {
        source.pool.forEach((item) => {
          if (!roleMatches(item.role, role)) return;
          const current = pool.get(item.champion) || { mastery: 0, frequency: 0 };
          current.mastery = Math.max(current.mastery, Number(item.masteryScore || 0));
          current.frequency += 1;
          pool.set(item.champion, current);
        });
        source.championRecords.forEach((record) => {
          if (record.role !== role) return;
          const current = pool.get(record.champion) || { mastery: 42, frequency: 0 };
          current.frequency += Math.min(3, record.games);
          pool.set(record.champion, current);
        });
      });
      return [...pool].map(([champion, evidence]) => ({
        champion,
        player,
        role,
        score: clamp(Math.round(42 + evidence.mastery * .12 + Math.min(7, evidence.frequency)), 42, 61),
        internalGames: 0,
        adjustedWinRate: .5,
        mastery: evidence.mastery,
        grade: "공용 후보",
        fallback: true,
      }));
    }).filter((item) => !used.has(item.champion) && !unique.has(item.champion));
    fallback.sort((a, b) => b.score - a.score).forEach((item) => {
      if (unique.size < limit && !unique.has(item.champion)) unique.set(item.champion, item);
    });
  }
  return [...unique.values()].slice(0, limit);
}

function draftEvidence(item) {
  if (item.fallback) return "챔프폭 근거 부족 · 라인 공용 후보";
  if (item.tierThreat >= 8) return `고티어 핵심픽 · 숙련 ${Math.round(item.mastery)}`;
  if (item.internalGames) return `내전 ${item.internalGames}경기 · 보정 승률 ${Math.round(item.adjustedWinRate * 100)}%`;
  return `${item.grade} · 장기 숙련 ${Math.round(item.mastery)}`;
}

function renderDraftBans(side) {
  const actions = draftActions(side, "ban");
  return Array.from({ length: 5 }, (_, index) => {
    const action = actions[index];
    return action
      ? `<div class="draft-ban-slot is-filled" title="${escapeHtml(action.champion)}">${championPortrait(action.champion, 38)}</div>`
      : `<div class="draft-ban-slot"><span>B${index + 1}</span></div>`;
  }).join("");
}

function renderDraftPicks(side) {
  const actions = draftActions(side, "pick");
  return Array.from({ length: 5 }, (_, index) => {
    const action = actions[index];
    if (!action) return `<div class="draft-pick-slot is-empty"><span>PICK ${index + 1}</span></div>`;
    const player = playerById(action.playerId);
    return `<div class="draft-pick-slot">${championPortrait(action.champion, 42)}<span><strong>${escapeHtml(action.champion)}</strong><small>${escapeHtml(action.role)} · ${escapeHtml(player?.name.split(" (")[0] || "직접 배정")}</small></span></div>`;
  }).join("");
}

function renderDraftCandidateOptions() {
  const options = $("#draft-champion-options");
  if (options) options.innerHTML = knownChampionNames().map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
}

function renderDraft() {
  if (!state.teams) return;
  const step = draftCurrentStep();
  const complete = !step;
  const blueIsMine = state.mySide === "blue";
  $("#draft-blue-label").textContent = blueIsMine ? "우리 팀" : "상대 팀";
  $("#draft-red-label").textContent = blueIsMine ? "상대 팀" : "우리 팀";
  $("#draft-blue-bans").innerHTML = renderDraftBans("blue");
  $("#draft-red-bans").innerHTML = renderDraftBans("red");
  $("#draft-blue-picks").innerHTML = renderDraftPicks("blue");
  $("#draft-red-picks").innerHTML = renderDraftPicks("red");
  $("#draft-progress").textContent = `${state.draftActions.length}/20`;
  $("#draft-undo").disabled = !state.draftActions.length;
  $("#draft-reset").disabled = !state.draftActions.length;
  renderDraftCandidateOptions();

  if (complete) {
    $("#draft-turn-banner").innerHTML = `<strong>밴픽 완료</strong><span>두 팀의 최종 조합을 확인하세요.</span>`;
    $("#draft-recommend-copy").textContent = "20턴이 모두 완료됐습니다.";
    $("#draft-candidate-list").innerHTML = `<div class="empty-insight compact-empty"><strong>밴픽이 완료됐습니다.</strong><p>되돌리거나 초기화해 다시 계산할 수 있습니다.</p></div>`;
    $("#draft-role-wrap").hidden = true;
    $("#draft-manual-apply").disabled = true;
    return;
  }

  const sideName = step.side === "blue" ? "블루" : "레드";
  const actionName = step.type === "ban" ? "밴" : "픽";
  const ownerName = step.side === state.mySide ? "우리 팀" : "상대 팀";
  $("#draft-turn-banner").innerHTML = `<strong class="turn-${step.side}">${state.draftActions.length + 1}번째 · ${sideName} ${actionName}</strong><span>${ownerName} 차례입니다.</span>`;
  $("#draft-recommend-copy").textContent = step.type === "ban"
    ? "상대의 아직 열려 있는 라인에서 견제 가치가 높은 순서입니다."
    : "아직 채우지 않은 라인에서 숙련 근거가 강한 순서입니다.";

  state.draftCandidates = draftRecommendations(7);
  $("#draft-candidate-list").innerHTML = state.draftCandidates.length ? state.draftCandidates.map((item, index) => `
    <button class="draft-candidate" data-draft-candidate="${index}">
      ${championPortrait(item.champion, 42)}
      <span class="draft-candidate-copy"><strong>${escapeHtml(item.champion)}</strong><small>${escapeHtml(item.role)} · ${escapeHtml(item.player.name.split(" (")[0])}</small><em>${escapeHtml(draftEvidence(item))}</em></span>
      <span class="draft-candidate-score"><b>${item.score}</b><small>${actionName}</small></span>
    </button>
  `).join("") : `<div class="empty-insight compact-empty"><strong>추천 가능한 챔피언이 없습니다.</strong><p>아래 직접 적용을 사용하세요.</p></div>`;

  const roleWrap = $("#draft-role-wrap");
  roleWrap.hidden = step.type !== "pick";
  $("#draft-role-select").innerHTML = draftAvailableRoles(step.side).map((role) => `<option value="${role}">${role}</option>`).join("");
  $("#draft-manual-apply").disabled = false;
}

function applyDraftAction(champion, role = "", candidate = null) {
  const step = draftCurrentStep();
  if (!step || !state.teams) return;
  const normalized = String(champion || "").trim();
  if (!normalized) return showToast("챔피언 이름을 입력하세요.");
  if (state.draftActions.some((action) => action.champion === normalized)) return showToast("이미 밴 또는 픽된 챔피언입니다.");
  let assignedRole = role;
  let playerId = "";
  if (step.type === "pick") {
    const available = draftAvailableRoles(step.side);
    assignedRole = available.includes(assignedRole) ? assignedRole : candidate?.role;
    if (!available.includes(assignedRole)) assignedRole = available[0];
    playerId = state.teams[step.side][assignedRole]?.id || "";
  }
  state.draftActions.push({
    side: step.side,
    type: step.type,
    champion: normalized,
    role: assignedRole || candidate?.role || "",
    playerId,
    score: candidate?.score || null,
  });
  $("#draft-champion-search").value = "";
  renderDraft();
  window.lucide?.createIcons();
}

function renderPlayerDirectory() {
  const query = state.playerQuery.trim().toLowerCase();
  const players = state.data.players.filter((player) => !query || searchableText(player).includes(query));
  $("#player-directory").innerHTML = players.map((player) => {
    const champs = player.championRecords.slice(0, 4).map((item) => item.champion);
    return `<button class="player-card" data-player-detail="${player.id}"><header><div><h3>${escapeHtml(displayPlayerName(player))}</h3><p>${escapeHtml(player.currentTier)} · 최고 ${escapeHtml(player.peakTier)}</p></div><span class="role-tag">${escapeHtml(player.primaryRole)}</span></header><div class="player-card-stats"><div><span>내전</span><strong>${player.games}경기</strong></div><div><span>승률</span><strong>${percent(player.winRate)}</strong></div><div><span>KDA</span><strong>${compact(player.kda)}</strong></div></div><div class="champion-line"><div class="slot-champs">${champs.map((champion) => championPortrait(champion)).join("")}</div><span>${escapeHtml(player.headlineChampions)}</span></div></button>`;
  }).join("");
}

function gameDetailMarkup(game) {
  return game.teams.map((team) => `<section class="game-team ${team.result === "승" ? "is-winner" : ""}"><header><span>${team.team}팀</span><strong>${team.result}</strong></header>${team.players.map((player) => {
    const registered = state.data.players.find((item) => item.name === player.player);
    return `<div class="game-player"><span>${player.role}</span>${championPortrait(player.champion, 34)}<strong>${escapeHtml(registered ? displayPlayerName(registered) : player.player)}</strong><small>${player.kills}/${player.deaths}/${player.assists}</small></div>`;
  }).join("")}</section>`).join("");
}

function renderGames() {
  $("#game-list").innerHTML = state.data.games.map((game, index) => {
    const winner = game.teams.find((team) => team.result === "승");
    const preview = winner.players.map((player) => `${player.player.split(" (")[0]} ${player.champion}`).join(" · ");
    return `<details class="game-row" data-game-index="${index}"><summary><span class="game-id">GAME ${String(game.id).padStart(2, "0")}</span><span class="game-date">${escapeHtml(game.date)}</span><span class="game-preview">승리 팀 · ${escapeHtml(preview)}</span><span class="game-time">${escapeHtml(game.duration)}${game.shortGame ? `<span class="short-badge">단기</span>` : ""}</span></summary><div class="game-detail" data-game-detail></div></details>`;
  }).join("");

  $$(".game-row").forEach((details) => details.addEventListener("toggle", () => {
    if (!details.open || details.dataset.loaded === "true") return;
    const game = state.data.games[Number(details.dataset.gameIndex)];
    details.querySelector("[data-game-detail]").innerHTML = gameDetailMarkup(game);
    details.dataset.loaded = "true";
  }));
}

function openPlayerDetail(id) {
  const player = playerById(id);
  if (!player) return;
  const secondary = secondaryRoleLabel(player);
  $("#player-detail").innerHTML = `<div class="detail-head"><h2>${escapeHtml(displayPlayerName(player))}</h2><p>${escapeHtml(player.riotId)} · 주라인 ${escapeHtml(player.primaryRole)}${secondary !== "없음" ? ` · 가능 ${escapeHtml(secondary)}` : ""}</p></div><div class="detail-facts"><div><span>현재 / 최고 티어</span><strong>${escapeHtml(player.currentTier)} / ${escapeHtml(player.peakTier)}</strong></div><div><span>내전 표본</span><strong>${player.games}경기 ${player.wins}승 ${player.losses}패</strong></div><div><span>승률</span><strong>${percent(player.winRate)}</strong></div><div><span>KDA</span><strong>${compact(player.kda)}</strong></div></div><section class="detail-section"><h3>내전 챔피언 기록</h3><table class="record-table"><thead><tr><th>챔피언</th><th>라인</th><th>경기</th><th>승률</th><th>KDA</th><th>표본</th></tr></thead><tbody>${player.championRecords.slice(0, 12).map((record) => `<tr><td><strong>${escapeHtml(record.champion)}</strong></td><td>${record.role}</td><td>${record.games}</td><td>${percent(record.winRate)}</td><td>${compact(record.kda)}</td><td>${escapeHtml(record.sample)}</td></tr>`).join("")}</tbody></table></section><section class="detail-section"><h3>전적 기반 챔프폭</h3><div class="pool-list">${player.pool.slice(0, 14).map((item) => `<div class="pool-row">${championPortrait(item.champion, 34)}<span><strong>${escapeHtml(item.champion)}</strong><small>${escapeHtml(item.role)} · 숙련 ${Math.round(item.masteryScore)}</small></span><span class="grade" data-grade="${escapeHtml(item.grade)}">${escapeHtml(item.grade)}</span></div>`).join("") || `<p>연결된 장기 전적 데이터가 없습니다.</p>`}</div></section>`;
  $("#player-dialog").showModal();
}

function renderEverything() {
  renderRoleFilters();
  renderRoster();
  renderSelectedStage();
  renderInsights();
  if ($("#view-draft").classList.contains("is-active")) renderDraft();
  if ($("#view-players").classList.contains("is-active")) renderPlayerDirectory();
  if ($("#view-games").classList.contains("is-active")) renderGames();
  window.lucide?.createIcons();
}

function resetSession() {
  state.selected = [];
  state.teams = null;
  state.draftActions = [];
  saveSelection();
  activateView("planner");
  renderEverything();
}

function activateView(view) {
  if (view === "draft" && !state.teams) {
    showToast("먼저 참가자 10명을 편성하세요.");
    return false;
  }
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $$(".app-view").forEach((section) => section.classList.toggle("is-active", section.id === `view-${view}`));
  if (view === "draft") renderDraft();
  if (view === "players") renderPlayerDirectory();
  if (view === "games") renderGames();
  window.scrollTo({ top: 0, behavior: "smooth" });
  window.lucide?.createIcons();
  return true;
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) activateView(viewButton.dataset.view);
  const openDraft = event.target.closest("[data-open-draft]");
  if (openDraft) activateView("draft");
  const roleButton = event.target.closest("[data-role-filter]");
  if (roleButton) { state.roleFilter = roleButton.dataset.roleFilter; renderRoleFilters(); renderRoster(); }
  const playerSelect = event.target.closest("[data-player-select]");
  if (playerSelect) {
    const id = playerSelect.dataset.playerSelect;
    state.selected = state.selected.includes(id) ? state.selected.filter((item) => item !== id) : [...state.selected, id];
    state.teams = null;
    state.draftActions = [];
    saveSelection();
    renderEverything();
  }
  const removePlayer = event.target.closest("[data-remove-player]");
  if (removePlayer) {
    state.selected = state.selected.filter((id) => id !== removePlayer.dataset.removePlayer);
    state.teams = null;
    state.draftActions = [];
    saveSelection();
    renderEverything();
  }
  const detailTarget = event.target.closest("[data-player-detail]");
  if (detailTarget && !event.target.closest("[data-remove-player]")) openPlayerDetail(detailTarget.dataset.playerDetail);
  const swapButton = event.target.closest("[data-swap-role]");
  if (swapButton && state.teams) {
    const role = swapButton.dataset.swapRole;
    [state.teams.blue[role], state.teams.red[role]] = [state.teams.red[role], state.teams.blue[role]];
    state.draftActions = [];
    renderEverything();
  }
  const sideButton = event.target.closest("[data-side]");
  if (sideButton) { state.mySide = sideButton.dataset.side; renderInsights(); if (state.teams) renderDraft(); }
  const draftCandidate = event.target.closest("[data-draft-candidate]");
  if (draftCandidate) {
    const candidate = state.draftCandidates[Number(draftCandidate.dataset.draftCandidate)];
    if (candidate) applyDraftAction(candidate.champion, candidate.role, candidate);
  }
});

$("#roster-search").addEventListener("input", (event) => { state.rosterQuery = event.target.value; renderRoster(); });
$("#player-search").addEventListener("input", (event) => { state.playerQuery = event.target.value; renderPlayerDirectory(); });
$("#balance-teams").addEventListener("click", createBalancedTeams);
$("#clear-selection").addEventListener("click", resetSession);
$("#reset-session").addEventListener("click", resetSession);
$("#load-recent").addEventListener("click", () => {
  const latest = state.data.games[0].teams.flatMap((team) => team.players.map((entry) => state.data.players.find((player) => player.name === entry.player)?.id)).filter(Boolean);
  state.selected = [...new Set(latest)].slice(0, 10);
  state.teams = null;
  state.draftActions = [];
  saveSelection();
  renderEverything();
  showToast("가장 최근 경기 참가자 10명을 불러왔습니다.");
});
$("#draft-undo").addEventListener("click", () => { state.draftActions.pop(); renderDraft(); window.lucide?.createIcons(); });
$("#draft-reset").addEventListener("click", () => { state.draftActions = []; renderDraft(); window.lucide?.createIcons(); });
$("#draft-manual-apply").addEventListener("click", () => {
  const query = $("#draft-champion-search").value.trim();
  const champion = knownChampionNames().find((name) => name.toLowerCase() === query.toLowerCase());
  if (!champion) return showToast("목록에 있는 정확한 챔피언 이름을 입력하세요.");
  applyDraftAction(champion, $("#draft-role-select").value);
});
$("#dialog-close").addEventListener("click", () => $("#player-dialog").close());
$("#player-dialog").addEventListener("click", (event) => { if (event.target === $("#player-dialog")) $("#player-dialog").close(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { event.preventDefault(); $("#roster-search").focus(); }
  if ((event.key === "Enter" || event.key === " ") && document.activeElement?.matches("[data-player-detail]")) { event.preventDefault(); openPlayerDetail(document.activeElement.dataset.playerDetail); }
});

$("#unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("#unlock-password").value;
  const submit = event.submitter;
  submit.disabled = true;
  $("#unlock-error").textContent = "암호화된 데이터를 확인하고 있습니다.";
  try {
    await unlockRemoteData(password);
  } catch {
    $("#unlock-error").textContent = "비밀번호가 맞지 않습니다.";
    $("#unlock-password").select();
  } finally {
    submit.disabled = false;
  }
});

async function boot() {
  const forceEncrypted = new URLSearchParams(location.search).has("encrypted");
  const isLocal = ["127.0.0.1", "localhost"].includes(location.hostname) && !forceEncrypted;
  if (isLocal) {
    const response = await fetch("data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`데이터를 불러오지 못했습니다 (${response.status})`);
    applyLoadedData(await response.json());
    return;
  }

  const response = await fetch("data.enc.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`암호화 데이터를 불러오지 못했습니다 (${response.status})`);
  state.encryptedPayload = await response.json();
  const cachedPassword = sessionStorage.getItem("inhouse:unlock");
  if (cachedPassword) {
    try {
      await unlockRemoteData(cachedPassword);
      return;
    } catch {
      sessionStorage.removeItem("inhouse:unlock");
    }
  }
  $("#unlock-dialog").showModal();
  $("#unlock-password").focus();
}

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main><div class="empty-state"><strong>내전 데이터를 열 수 없습니다.</strong><p>${escapeHtml(error.message)}. 이 폴더를 로컬 서버로 열어주세요.</p></div></main>`;
});

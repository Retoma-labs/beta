import crypto from "node:crypto";
import fs from "node:fs";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createAppJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function answerFor(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`###\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n###\\s+|$)`, "i"));
  if (!match) return "";
  return match[1].trim();
}

export function validateApplication(issue) {
  const body = issue?.body ?? "";
  const required = [
    "Experiência atual",
    "Sistema operacional",
    "Projeto em que pretende testar",
    "Onde você normalmente perde o contexto?",
  ];
  const missing = required.filter((heading) => {
    const answer = answerFor(body, heading);
    return !answer || /^_?no response_?$/i.test(answer) || /^_?sem resposta_?$/i.test(answer);
  });
  const commitments = (body.match(/^\s*-\s*\[[xX]\]\s+/gm) ?? []).length;

  if (!/^\[Candidatura\]/i.test(issue?.title ?? "")) {
    missing.push("título iniciado por [Candidatura]");
  }
  if (commitments < 3) {
    missing.push(`3 compromissos marcados (${commitments}/3)`);
  }

  return { eligible: missing.length === 0, missing };
}

class GitHubApi {
  constructor(token) {
    this.token = token;
  }

  async request(method, path, body, allowed = []) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "retoma-beta-operator",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allowed.includes(response.status)) return null;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`${method} ${path}: HTTP ${response.status} ${detail}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  get(path) { return this.request("GET", path); }
  post(path, body) { return this.request("POST", path, body); }
  put(path, body) { return this.request("PUT", path, body); }
  delete(path, allowed = []) { return this.request("DELETE", path, undefined, allowed); }
}

async function installationToken(appId, privateKey, org) {
  const jwt = createAppJwt(appId, privateKey);
  const appApi = new GitHubApi(jwt);
  const installation = await appApi.get(`/orgs/${encodeURIComponent(org)}/installation`);
  const result = await appApi.post(`/app/installations/${installation.id}/access_tokens`, {});
  return { token: result.token, installationId: installation.id, accountId: installation.account.id };
}

function uniqueLogins(items) {
  return new Set(items.map((item) => item.login?.toLowerCase()).filter(Boolean));
}

async function getCohort(api, org, orgId, teamSlug) {
  const teamPath = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`;
  const team = await api.get(teamPath);
  const members = await api.get(`${teamPath}/members?per_page=100`);
  const invitations = await api.get(`/orgs/${encodeURIComponent(org)}/invitations?per_page=100`);
  const pending = [];

  for (const invitation of invitations) {
    if (!invitation.invitee?.login) continue;
    const teams = await api.get(`/organizations/${orgId}/invitations/${invitation.id}/teams`);
    if (teams.some((candidate) => candidate.id === team.id)) {
      pending.push(invitation.invitee);
    }
  }

  const activeLogins = uniqueLogins(members);
  const pendingLogins = uniqueLogins(pending);
  return {
    team,
    activeLogins,
    pendingLogins,
    occupied: new Set([...activeLogins, ...pendingLogins]).size,
  };
}

async function addLabels(api, org, repository, issueNumber, labels) {
  if (!labels.length) return;
  await api.post(`/repos/${org}/${repository}/issues/${issueNumber}/labels`, { labels });
}

async function removeLabels(api, org, repository, issueNumber, labels) {
  for (const label of labels) {
    await api.delete(
      `/repos/${org}/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      [404],
    );
  }
}

async function commentOnce(api, org, repository, issueNumber, marker, text) {
  const comments = await api.get(`/repos/${org}/${repository}/issues/${issueNumber}/comments?per_page=100`);
  if (comments.some((comment) => comment.body?.includes(marker))) return;
  await api.post(`/repos/${org}/${repository}/issues/${issueNumber}/comments`, {
    body: `${marker}\n${text}`,
  });
}

async function markIncomplete(api, config, issue, missing) {
  await addLabels(api, config.org, config.repository, issue.number, ["incomplete"]);
  await removeLabels(api, config.org, config.repository, issue.number, ["candidate", "selected", "waitlist"]);
  await commentOnce(
    api,
    config.org,
    config.repository,
    issue.number,
    "<!-- retoma-beta-operator:incomplete -->",
    `A candidatura ainda não pode entrar na seleção automática. Revise: ${missing.join("; ")}. Depois, edite esta issue para uma nova avaliação.`,
  );
}

async function selectCandidate(api, config, issue, cohort) {
  const login = issue.user.login;
  const normalized = login.toLowerCase();
  const alreadyInside = cohort.activeLogins.has(normalized) || cohort.pendingLogins.has(normalized);

  if (!alreadyInside && cohort.occupied >= config.capacity) {
    await addLabels(api, config.org, config.repository, issue.number, ["waitlist"]);
    await removeLabels(api, config.org, config.repository, issue.number, ["candidate", "selected", "incomplete"]);
    await commentOnce(
      api,
      config.org,
      config.repository,
      issue.number,
      "<!-- retoma-beta-operator:waitlist -->",
      "As 10 vagas estão ocupadas. Sua candidatura entrou automaticamente na lista de espera e será reavaliada quando uma vaga for liberada.",
    );
    return { status: "waitlist", occupied: cohort.occupied };
  }

  if (!alreadyInside) {
    await api.put(
      `/orgs/${config.org}/teams/${config.teamSlug}/memberships/${encodeURIComponent(login)}`,
      { role: "member" },
    );
    cohort.pendingLogins.add(normalized);
    cohort.occupied += 1;
  }

  await addLabels(api, config.org, config.repository, issue.number, ["selected"]);
  await removeLabels(api, config.org, config.repository, issue.number, ["candidate", "waitlist", "incomplete"]);
  await commentOnce(
    api,
    config.org,
    config.repository,
    issue.number,
    "<!-- retoma-beta-operator:selected -->",
    alreadyInside
      ? "Seu acesso ao Beta 10 já está ativo ou aguardando aceite. Consulte as notificações do GitHub."
      : "Você foi selecionado para o Beta 10. O GitHub enviará o convite oficial; aceite-o para acessar os recursos privados do programa.",
  );
  return { status: alreadyInside ? "already-selected" : "selected", occupied: cohort.occupied };
}

async function processIssue(api, config, issue, cohort) {
  const validation = validateApplication(issue);
  if (!validation.eligible) {
    await markIncomplete(api, config, issue, validation.missing);
    return { status: "incomplete", missing: validation.missing };
  }
  return selectCandidate(api, config, issue, cohort);
}

async function appendSummary(lines) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${lines.join("\n")}\n`);
}

async function main() {
  const config = {
    appId: process.env.RETOMA_APP_ID,
    privateKey: process.env.RETOMA_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    org: process.env.RETOMA_ORG ?? "Retoma-labs",
    repository: process.env.RETOMA_REPOSITORY ?? "beta",
    teamSlug: process.env.RETOMA_TEAM_SLUG ?? "beta-testers",
    capacity: Number(process.env.RETOMA_CAPACITY ?? "10"),
    mode: process.env.RETOMA_MODE ?? "validate",
  };

  if (!config.appId || !config.privateKey) throw new Error("Segredos RETOMA_APP_ID e RETOMA_APP_PRIVATE_KEY ausentes.");
  if (!Number.isInteger(config.capacity) || config.capacity < 1) throw new Error("RETOMA_CAPACITY inválida.");

  const auth = await installationToken(config.appId, config.privateKey, config.org);
  const api = new GitHubApi(auth.token);
  const cohort = await getCohort(api, config.org, auth.accountId, config.teamSlug);
  const baseSummary = [
    "## Retoma Beta Operator",
    `- Instalação do App: ${auth.installationId}`,
    `- Vagas ocupadas ou pendentes: ${cohort.occupied}/${config.capacity}`,
    `- Modo: ${config.mode}`,
  ];

  if (config.mode === "validate") {
    await api.get(`/repos/${config.org}/${config.repository}`);
    await appendSummary([...baseSummary, "- Resultado: autenticação e permissões validadas; nenhuma alteração realizada."]);
    console.log("Validação aprovada; nenhuma candidatura foi alterada.");
    return;
  }

  if (config.mode === "reconcile") {
    const waiting = await api.get(
      `/repos/${config.org}/${config.repository}/issues?state=open&labels=waitlist&sort=created&direction=asc&per_page=100`,
    );
    let promoted = 0;
    for (const issue of waiting) {
      if (cohort.occupied >= config.capacity) break;
      const result = await processIssue(api, config, issue, cohort);
      if (result.status === "selected") promoted += 1;
    }
    await appendSummary([...baseSummary, `- Candidaturas promovidas da espera: ${promoted}`]);
    console.log(`Reconciliação concluída; ${promoted} candidatura(s) promovida(s).`);
    return;
  }

  if (process.env.GITHUB_EVENT_NAME !== "issues") {
    throw new Error(`Modo ${config.mode} exige evento de issue.`);
  }
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!event.issue || event.issue.pull_request) throw new Error("Evento não contém uma candidatura válida.");
  const result = await processIssue(api, config, event.issue, cohort);
  await appendSummary([...baseSummary, `- Issue: #${event.issue.number}`, `- Resultado: ${result.status}`]);
  console.log(`Candidatura #${event.issue.number}: ${result.status}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`ERRO: ${error.message}`);
    process.exitCode = 1;
  });
}

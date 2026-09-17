const assert = require('node:assert/strict');
const { compare } = require('./core-update-policy.cjs');

async function verify({ api, sha, tag, repo }) {
  assert(/^v\d+\.\d+\.\d+$/.test(tag), 'A stable release tag is required');
  assert.equal((await api('git/ref/tags/' + tag)).object.sha, sha, 'Release tag moved');
  const related = await api('commits/' + sha + '/pulls');
  const pr = related.find((item) => item.merged_at && item.merge_commit_sha === sha);
  assert(pr, 'Automatic releases require a merged PR');
  assert.equal(pr.user.login, 'github-actions[bot]');
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.head.repo.full_name, repo);
  assert(pr.head.ref.startsWith('agent/codex/core-update-'));
  const changed = await api('pulls/' + pr.number + '/files?per_page=100');
  assert.deepEqual(changed.map((file) => file.filename).sort(), ['desktop/package-lock.json', 'desktop/package.json']);
  const merged = await api('git/commits/' + sha), tested = await api('git/commits/' + pr.head.sha);
  assert.equal(merged.tree.sha, tested.tree.sha, 'Release contents differ from the checked PR');
  for (const name of ['ci.yml', 'security.yml', 'desktop-windows.yml']) {
    const runs = await api('actions/workflows/' + name + '/runs?event=workflow_dispatch&per_page=100');
    const run = runs.workflow_runs.find((item) => item.head_sha === pr.head.sha && item.event === 'workflow_dispatch');
    assert(run && run.status === 'completed' && run.conclusion === 'success', 'Missing successful check: ' + name);
  }
  const latest = await api('releases/latest');
  assert(compare(tag.slice(1), latest.tag_name.replace(/^v/, '')) > 0, 'Refusing to replace an equal or newer published release');
}
if (require.main === module) {
  const repo = process.env.GITHUB_REPOSITORY;
  const api = async (route) => {
    const response = await fetch('https://api.github.com/repos/' + repo + '/' + route, {
      headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, 'Unable to verify release provenance: ' + response.status);
    return response.json();
  };
  verify({ api, repo, sha: process.env.GITHUB_SHA, tag: process.env.GITHUB_REF_NAME }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verify };

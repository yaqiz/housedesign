const API_BASE = 'https://api.netlify.com/api/v1';
const TEACHER_BOARD_CODE = 'becky2026';

async function netlifyApi(path, token, options = {}) {
  const response = await fetch(API_BASE + path, {
    method: options.method || 'GET',
    headers: Object.assign(
      { Authorization: `Bearer ${token}` },
      options.headers || {}
    ),
    body: options.body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Netlify API ${response.status}: ${text.slice(0, 160)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;

  if (!token || !siteId) {
    return json(500, { error: 'Missing NETLIFY_AUTH_TOKEN or NETLIFY_SITE_ID' });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }

  if ((payload.teacher_code || '').trim() !== TEACHER_BOARD_CODE) {
    return json(403, { error: 'Invalid teacher code' });
  }

  try {
    const forms = await netlifyApi(`/sites/${siteId}/forms`, token);
    const designForm = forms.find((form) => form.name === 'house-design-submissions');
    const reviewForm = forms.find((form) => form.name === 'house-design-reviews');

    const designSubmissions = designForm
      ? await netlifyApi(`/forms/${designForm.id}/submissions`, token)
      : [];
    const reviewSubmissions = reviewForm
      ? await netlifyApi(`/forms/${reviewForm.id}/submissions`, token)
      : [];

    if (payload.action === 'delete_one') {
      const submissionId = String(payload.submission_id || '').trim();
      if (!submissionId) return json(400, { error: 'submission_id is required' });

      const linkedReviews = reviewSubmissions.filter((submission) => {
        const data = submission.data || {};
        return String(data.design_id || '') === submissionId;
      });

      for (const review of linkedReviews) {
        await netlifyApi(`/submissions/${review.id}`, token, { method: 'DELETE' });
      }
      await netlifyApi(`/submissions/${submissionId}`, token, { method: 'DELETE' });

      return json(200, {
        ok: true,
        deleted_design_submission_id: submissionId,
        deleted_review_count: linkedReviews.length
      });
    }

    if (payload.action === 'reset_all') {
      let deletedDesigns = 0;
      let deletedReviews = 0;

      for (const submission of reviewSubmissions) {
        await netlifyApi(`/submissions/${submission.id}`, token, { method: 'DELETE' });
        deletedReviews += 1;
      }
      for (const submission of designSubmissions) {
        await netlifyApi(`/submissions/${submission.id}`, token, { method: 'DELETE' });
        deletedDesigns += 1;
      }

      return json(200, {
        ok: true,
        deleted_design_count: deletedDesigns,
        deleted_review_count: deletedReviews
      });
    }

    return json(400, { error: 'Unknown action' });
  } catch (error) {
    return json(500, { error: error.message });
  }
};

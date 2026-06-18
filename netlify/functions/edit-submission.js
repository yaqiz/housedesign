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

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function parseJsonField(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

async function submitFormSubmission(event, fields) {
  const host = event.headers.host;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const body = new URLSearchParams(fields).toString();
  const response = await fetch(`${proto}://${host}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    throw new Error(`Could not create replacement submission: ${response.status}`);
  }
}

function readSubmissionData(submission) {
  return submission && submission.data ? submission.data : {};
}

async function recreateReviews(event, linkedReviews, newDesignId) {
  for (const review of linkedReviews) {
    const data = readSubmissionData(review);
    await submitFormSubmission(event, {
      'form-name': 'house-design-reviews',
      design_id: newDesignId,
      reviewer_name: data.reviewer_name || '',
      stars: data.stars || '',
      comment: data.comment || '',
      submitted_at: data.submitted_at || new Date().toISOString()
    });
  }
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

  const submissionId = String(payload.submission_id || '').trim();
  const action = String(payload.action || '').trim();
  const studentName = String(payload.student_name || '').trim();
  const editCode = String(payload.edit_code || '').trim();

  if (!submissionId) {
    return json(400, { error: 'submission_id is required' });
  }

  try {
    const forms = await netlifyApi(`/sites/${siteId}/forms`, token);
    const designForm = forms.find((form) => form.name === 'house-design-submissions');
    const reviewForm = forms.find((form) => form.name === 'house-design-reviews');
    if (!designForm) return json(404, { error: 'Design form not found' });

    const designSubmissions = await netlifyApi(`/forms/${designForm.id}/submissions`, token);
    const reviewSubmissions = reviewForm
      ? await netlifyApi(`/forms/${reviewForm.id}/submissions`, token)
      : [];

    const target = designSubmissions.find((submission) => submission.id === submissionId);
    if (!target) return json(404, { error: 'Submission not found' });

    const data = readSubmissionData(target);

    if (action === 'teacher_reset_code') {
      const teacherCode = String(payload.teacher_code || '').trim();
      const newEditCode = String(payload.new_edit_code || '').trim();
      if (teacherCode !== TEACHER_BOARD_CODE) {
        return json(403, { error: 'Invalid teacher code' });
      }
      if (!newEditCode) {
        return json(400, { error: 'new_edit_code is required' });
      }

      const linkedReviews = reviewSubmissions.filter((submission) => {
        const reviewData = readSubmissionData(submission);
        return String(reviewData.design_id || '') === submissionId;
      });

      await submitFormSubmission(event, {
        'form-name': 'house-design-submissions',
        student_name: data.student_name || '',
        style: data.style || '',
        edit_code: newEditCode,
        design_json: data.design_json || '',
        submitted_at: data.submitted_at || new Date().toISOString()
      });

      const refreshedDesignSubmissions = await netlifyApi(`/forms/${designForm.id}/submissions`, token);
      const replacement = refreshedDesignSubmissions.find((submission) => {
        const submissionData = readSubmissionData(submission);
        return (
          submission.id !== submissionId &&
          String(submissionData.student_name || '') === String(data.student_name || '') &&
          String(submissionData.submitted_at || '') === String(data.submitted_at || '') &&
          String(submissionData.edit_code || '') === newEditCode
        );
      });

      if (!replacement) {
        throw new Error('Could not find the replacement submission after reset');
      }

      await recreateReviews(event, linkedReviews, replacement.id);

      for (const review of linkedReviews) {
        await netlifyApi(`/submissions/${review.id}`, token, { method: 'DELETE' });
      }
      await netlifyApi(`/submissions/${submissionId}`, token, { method: 'DELETE' });

      return json(200, {
        ok: true,
        new_submission_id: replacement.id,
        restored_review_count: linkedReviews.length
      });
    }

    if (!studentName || !editCode) {
      return json(400, { error: 'student_name and edit_code are required' });
    }

    if (normalizeName(data.student_name) !== normalizeName(studentName)) {
      return json(403, { error: 'Name does not match this submission' });
    }
    if (String(data.edit_code || '').trim() !== editCode) {
      return json(403, { error: 'Edit code is incorrect' });
    }

    if (action === 'verify') {
      return json(200, { ok: true });
    }

    if (action === 'update') {
      const designPayload = payload.design_payload || {};
      if (!designPayload || typeof designPayload !== 'object') {
        return json(400, { error: 'design_payload is required' });
      }

      await submitFormSubmission(event, {
        'form-name': 'house-design-submissions',
        student_name: studentName,
        style: designPayload.styleName || designPayload.style || '',
        edit_code: editCode,
        design_json: JSON.stringify(designPayload),
        submitted_at: designPayload.submittedAt || new Date().toISOString()
      });

      const linkedReviews = reviewSubmissions.filter((submission) => {
        const reviewData = submission.data || {};
        return String(reviewData.design_id || '') === submissionId;
      });

      for (const review of linkedReviews) {
        await netlifyApi(`/submissions/${review.id}`, token, { method: 'DELETE' });
      }
      await netlifyApi(`/submissions/${submissionId}`, token, { method: 'DELETE' });

      return json(200, {
        ok: true,
        deleted_review_count: linkedReviews.length
      });
    }

    return json(400, { error: 'Unknown action' });
  } catch (error) {
    return json(500, { error: error.message });
  }
};

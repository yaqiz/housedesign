const API_BASE = 'https://api.netlify.com/api/v1';

async function netlifyApi(path, token) {
  const response = await fetch(API_BASE + path, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Netlify API ${response.status}: ${text.slice(0, 160)}`);
  }
  return response.json();
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

exports.handler = async function () {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;

  if (!token || !siteId) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupRequired: true,
        message: 'Set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in Netlify environment variables.'
      })
    };
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

    const reviews = reviewSubmissions.map((submission) => {
      const data = submission.data || {};
      return {
        id: submission.id,
        designId: data.design_id || '',
        reviewerName: data.reviewer_name || 'Reviewer',
        stars: Number(data.stars || 0),
        comment: data.comment || '',
        createdAt: submission.created_at
      };
    });

    const reviewsByDesign = reviews.reduce((acc, review) => {
      if (!review.designId) return acc;
      if (!acc[review.designId]) acc[review.designId] = [];
      acc[review.designId].push(review);
      return acc;
    }, {});

    const designs = designSubmissions.map((submission) => {
      const data = submission.data || {};
      const design = parseJsonField(data.design_json) || {};
      const designReviews = reviewsByDesign[submission.id] || [];
      const averageStars = designReviews.length
        ? designReviews.reduce((sum, review) => sum + (review.stars || 0), 0) / designReviews.length
        : 0;
      return {
        id: submission.id,
        studentName: data.student_name || design.studentName || 'Student',
        style: design.style || '',
        styleName: data.style || design.styleName || '',
        submittedAt: data.submitted_at || design.submittedAt || submission.created_at,
        design,
        reviewCount: designReviews.length,
        averageStars,
        reviews: designReviews
      };
    }).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify({ setupRequired: false, designs })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};

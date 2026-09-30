/**
 * wp-static-form.js
 * WordPress 静的サイト (Static Site) 用 フォーム連携ブリッジスクリプト
 * Contact Form 7 / Schema-Woven Validation (SWV) / WPForms / 汎用カスタムフォーム完全対応
 */
(function () {
  'use strict';

  /**
   * API エンドポイントを動的に解決 (優先順位: form action > metaタグ > window設定 > 相対パス)
   * ※特定のホスト名や localhost はハードコードせず、環境に応じて自動判定
   */
  function getApiEndpoint(form) {
    const action = form ? form.getAttribute('action') : null;
    if (action && !action.includes('wp-json') && action !== '#' && action !== '' && !action.startsWith('javascript:')) {
      return action;
    }

    const metaApi = document.querySelector('meta[name="wp-static-api-endpoint"]');
    if (metaApi && metaApi.getAttribute('content')) {
      return metaApi.getAttribute('content');
    }

    return (window.WP_STATIC_API_ENDPOINT) || "http:\/\/localhost:3082\/api\/v1\/forms\/submit";
  }

  function initForms() {
    const cf7Forms = document.querySelectorAll(
      'form.wpcf7-form, form[action*="wp-json/contact-form-7"], form[action*="forms/submit"], form[data-static-form="true"]'
    );
    cf7Forms.forEach((form) => attachCf7Handler(form));

    // その他の汎用フォーム
    const otherForms = document.querySelectorAll('form[data-wpss-form="true"], form.mw_wp_form');
    otherForms.forEach((form) => attachCustomHandler(form));
  }

  /**
   * フォーム内のフィールド要素を探索
   */
  function findFieldElement(form, fieldName) {
    if (!fieldName) return null;
    return (
      form.querySelector(`[name="${fieldName}"]`) ||
      form.querySelector(`[name="${fieldName}[]"]`) ||
      form.querySelector(`[data-name="${fieldName}"] input, [data-name="${fieldName}"] select, [data-name="${fieldName}"] textarea`) ||
      form.querySelector(`[data-name="${fieldName}"]`)
    );
  }

  /**
   * フォーム要素の値または選択状態を取得
   */
  function getFieldValue(form, fieldName) {
    const el = findFieldElement(form, fieldName);
    if (!el) return '';

    // Checkbox / Radio
    if (el.type === 'checkbox' || el.type === 'radio') {
      const name = el.name || fieldName;
      const checked = form.querySelectorAll(`[name="${name}"]:checked`);
      if (checked.length === 0) return '';
      if (checked.length === 1) return checked[0].value;
      return Array.from(checked).map((c) => c.value);
    }

    if (el.type === 'file') {
      return el.files && el.files.length > 0 ? el.files : '';
    }

    return (el.value || '').trim();
  }

  /**
   * Contact Form 7 の SWV (Schema-Woven Validation) JSONを取得
   */
  function getSwvSchema(form) {
    const script =
      form.querySelector('script.wpcf7-schema-woven-validation') ||
      form.closest('.wpcf7')?.querySelector('script.wpcf7-schema-woven-validation') ||
      form.parentElement?.querySelector('script.wpcf7-schema-woven-validation') ||
      document.querySelector('script.wpcf7-schema-woven-validation');

    if (!script) return null;

    try {
      return JSON.parse(script.textContent || script.innerText);
    } catch (e) {
      console.warn('[wp-static-form] Failed to parse SWV schema:', e);
      return null;
    }
  }

  /**
   * エラー表示 (Contact Form 7 互換)
   */
  function setFieldError(form, fieldName, message) {
    const el = findFieldElement(form, fieldName);
    if (!el) return;

    el.classList.add('wpcf7-not-valid');
    el.setAttribute('aria-invalid', 'true');

    const wrap = el.closest('.wpcf7-form-control-wrap') || el.parentElement;
    if (wrap) {
      wrap.querySelectorAll('.wpcf7-not-valid-tip').forEach((t) => t.remove());

      const tip = document.createElement('span');
      tip.className = 'wpcf7-not-valid-tip';
      tip.setAttribute('aria-hidden', 'true');
      tip.textContent = message;
      wrap.appendChild(tip);
    }

    // ユーザーが入力を修正した際にエラーを消去
    const clearError = () => {
      el.classList.remove('wpcf7-not-valid');
      el.removeAttribute('aria-invalid');
      if (wrap) {
        wrap.querySelectorAll('.wpcf7-not-valid-tip').forEach((t) => t.remove());
      }
      if (!form.querySelector('.wpcf7-not-valid')) {
        const responseBox = form.querySelector('.wpcf7-response-output');
        if (responseBox) {
          responseBox.style.display = 'none';
          responseBox.className = 'wpcf7-response-output';
        }
        form.classList.remove('failed');
      }
      el.removeEventListener('input', clearError);
      el.removeEventListener('change', clearError);
    };

    el.addEventListener('input', clearError);
    el.addEventListener('change', clearError);
  }

  /**
   * 単一の SWV ルールを検証
   */
  function validateSwvRule(form, rule) {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    const telRegex = /^[0-9+\-()\s]{6,20}$/;

    const fieldName = rule.field;
    const ruleType = rule.rule;
    const customError = rule.error;

    if (ruleType === 'all' && Array.isArray(rule.rules)) {
      for (const subRule of rule.rules) {
        const err = validateSwvRule(form, subRule);
        if (err) return err;
      }
      return null;
    }

    if (ruleType === 'any' && Array.isArray(rule.rules)) {
      let anyPassed = false;
      let lastErr = null;
      for (const subRule of rule.rules) {
        const err = validateSwvRule(form, subRule);
        if (!err) {
          anyPassed = true;
          break;
        }
        lastErr = err;
      }
      return anyPassed ? null : (lastErr || { field: fieldName, message: customError || '入力内容をご確認ください。' });
    }

    if (!fieldName) return null;
    const el = findFieldElement(form, fieldName);
    if (!el) return null;

    const val = getFieldValue(form, fieldName);

    // 1. required ルール
    if (ruleType === 'required') {
      let isEmpty = false;
      if (el.type === 'file') {
        isEmpty = !el.files || el.files.length === 0;
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        const checked = form.querySelectorAll(`[name="${el.name}"]:checked`);
        isEmpty = checked.length === 0;
      } else if (Array.isArray(val)) {
        isEmpty = val.length === 0;
      } else {
        isEmpty = !val || val === '';
      }

      if (isEmpty) {
        return {
          field: fieldName,
          message: customError || '必須項目に入力してください。',
        };
      }
      return null;
    }

    // 値が空の場合は必須チェック以外のルールはスキップ (CF7 の仕様準拠)
    if (!val || (typeof val === 'string' && val === '') || (Array.isArray(val) && val.length === 0)) {
      return null;
    }

    // 2. email ルール
    if (ruleType === 'email') {
      const emailStr = typeof val === 'string' ? val : '';
      if (!emailRegex.test(emailStr)) {
        return {
          field: fieldName,
          message: customError || '入力されたメールアドレスに間違いがあります。',
        };
      }
    }

    // 3. tel ルール
    if (ruleType === 'tel') {
      const telStr = typeof val === 'string' ? val : '';
      if (!telRegex.test(telStr)) {
        return {
          field: fieldName,
          message: customError || '電話番号の形式が正しくありません。',
        };
      }
    }

    // 4. url ルール
    if (ruleType === 'url') {
      const urlStr = typeof val === 'string' ? val : '';
      if (!/^https?:\/\/.+/i.test(urlStr)) {
        return {
          field: fieldName,
          message: customError || 'URLの形式が正しくありません。',
        };
      }
    }

    // 5. number ルール
    if (ruleType === 'number') {
      const num = Number(val);
      if (isNaN(num)) {
        return { field: fieldName, message: customError || '数値を入力してください。' };
      }
      if (rule.min !== undefined && num < rule.min) {
        return { field: fieldName, message: customError || `${rule.min}以上の数値を入力してください。` };
      }
      if (rule.max !== undefined && num > rule.max) {
        return { field: fieldName, message: customError || `${rule.max}以下の数値を入力してください。` };
      }
    }

    // 6. minlength / maxlength
    if (ruleType === 'minlength') {
      const str = String(val);
      if (rule.threshold && str.length < rule.threshold) {
        return { field: fieldName, message: customError || `${rule.threshold}文字以上で入力してください。` };
      }
    }
    if (ruleType === 'maxlength') {
      const str = String(val);
      if (rule.threshold && str.length > rule.threshold) {
        return { field: fieldName, message: customError || `${rule.threshold}文字以内で入力してください。` };
      }
    }

    // 7. file / maxfilesize / minfilesize
    if (el.type === 'file' && el.files && el.files.length > 0) {
      for (let i = 0; i < el.files.length; i++) {
        const file = el.files[i];
        if (ruleType === 'maxfilesize' && rule.threshold && file.size > rule.threshold) {
          const mb = Math.round(rule.threshold / 1048576);
          return { field: fieldName, message: customError || `ファイルサイズが上限（${mb}MB）を超えています。` };
        }
        if (ruleType === 'file' && Array.isArray(rule.accept) && rule.accept.length > 0) {
          const ext = '.' + file.name.split('.').pop().toLowerCase();
          const matches = rule.accept.some((allowed) => {
            const clean = allowed.toLowerCase().trim();
            return clean === ext || clean === ext.replace('.', '') || (clean.includes('/') && file.type === clean);
          });
          if (!matches) {
            return { field: fieldName, message: customError || '許可されていないファイル形式です。' };
          }
        }
      }
    }

    // 8. minitems / maxitems (checkbox グループ等)
    if (ruleType === 'minitems' && Array.isArray(val) && rule.threshold && val.length < rule.threshold) {
      return { field: fieldName, message: customError || `${rule.threshold}個以上選択してください。` };
    }
    if (ruleType === 'maxitems' && Array.isArray(val) && rule.threshold && val.length > rule.threshold) {
      return { field: fieldName, message: customError || `${rule.threshold}個以内で選択してください。` };
    }

    return null;
  }

  /**
   * フォーム全体のバリデーション実行 (SWV優先 + DOM Fallback)
   */
  function validateFormLocally(form) {
    const invalidFields = [];
    const validatedFields = new Set();

    // 1. Contact Form 7 の SWV (Schema-Woven Validation) が存在する場合
    const swv = getSwvSchema(form);
    if (swv && Array.isArray(swv.rules)) {
      for (const rule of swv.rules) {
        const err = validateSwvRule(form, rule);
        if (err && !validatedFields.has(err.field)) {
          invalidFields.push(err);
          validatedFields.add(err.field);
        }
      }
    }

    // 2. DOM 属性ベースの Fallback バリデーション (SWVでカバーされていない項目や他プラグイン対応)
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    const telRegex = /^[0-9+\-()\s]{6,20}$/;

    // Acceptance (承諾確認チェックボックス: [acceptance ...])
    form.querySelectorAll('.wpcf7-acceptance').forEach((wrap) => {
      const chk = wrap.querySelector('input[type="checkbox"]');
      if (chk && !chk.checked && !wrap.classList.contains('optional')) {
        const name = (chk.name || 'acceptance').replace(/\[\]$/, '');
        if (!validatedFields.has(name)) {
          invalidFields.push({
            field: name,
            message: '送信するには承諾確認のチェックが必要です。',
          });
          validatedFields.add(name);
        }
      }
    });

    // 必須要素 (HTML5 required, aria-required, wpcf7 クラス)
    const requiredElements = form.querySelectorAll(
      '[required], [aria-required="true"], .wpcf7-validates-as-required, .wpcf7-validates-as-email, .wpcf7-validates-as-tel'
    );

    requiredElements.forEach((el) => {
      let input = el;
      if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
        input = el.querySelector('input, select, textarea');
      }
      if (!input || !input.name) return;

      const name = input.name.replace(/\[\]$/, '');
      if (validatedFields.has(name)) return;

      const isRequired =
        input.hasAttribute('required') ||
        input.getAttribute('aria-required') === 'true' ||
        input.classList.contains('wpcf7-validates-as-required') ||
        el.classList.contains('wpcf7-validates-as-required') ||
        el.closest('.wpcf7-form-control-wrap')?.querySelector('.wpcf7-validates-as-required');

      if (input.type === 'checkbox') {
        const checkedBoxes = form.querySelectorAll(`[name="${input.name}"]:checked`);
        if (isRequired && checkedBoxes.length === 0) {
          invalidFields.push({ field: name, message: '必須項目に入力してください。' });
          validatedFields.add(name);
        }
      } else if (input.type === 'radio') {
        const checkedRadio = form.querySelector(`[name="${input.name}"]:checked`);
        if (isRequired && !checkedRadio) {
          invalidFields.push({ field: name, message: '必須項目に入力してください。' });
          validatedFields.add(name);
        }
      } else if (input.type === 'file') {
        if (isRequired && (!input.files || input.files.length === 0)) {
          invalidFields.push({ field: name, message: '必須項目に入力してください。' });
          validatedFields.add(name);
        }
      } else {
        const val = input.value ? input.value.trim() : '';
        if (isRequired && val === '') {
          invalidFields.push({ field: name, message: '必須項目に入力してください。' });
          validatedFields.add(name);
        } else if (val !== '') {
          if (input.type === 'email' || name.includes('email') || input.classList.contains('wpcf7-validates-as-email')) {
            if (!emailRegex.test(val)) {
              invalidFields.push({ field: name, message: '入力されたメールアドレスに間違いがあります。' });
              validatedFields.add(name);
            }
          } else if (input.type === 'tel' || input.classList.contains('wpcf7-validates-as-tel')) {
            if (!telRegex.test(val)) {
              invalidFields.push({ field: name, message: '電話番号の形式が正しくありません。' });
              validatedFields.add(name);
            }
          }
        }
      }
    });

    return invalidFields;
  }

  /**
   * フォーム内の必須項目名一覧を抽出
   */
  function collectRequiredFields(form) {
    const reqSet = new Set();

    // 1. SWV Schema から取得
    const swv = getSwvSchema(form);
    if (swv && Array.isArray(swv.rules)) {
      const extractReq = (rule) => {
        if (rule.rule === 'required' && rule.field) {
          reqSet.add(rule.field.replace(/\[\]$/, ''));
        } else if (rule.rules && Array.isArray(rule.rules)) {
          rule.rules.forEach(extractReq);
        }
      };
      swv.rules.forEach(extractReq);
    }

    // 2. DOM 属性から取得
    form.querySelectorAll('[required], [aria-required="true"], .wpcf7-validates-as-required').forEach((el) => {
      const input = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? el : el.querySelector('input, select, textarea');
      if (input && input.name) {
        reqSet.add(input.name.replace(/\[\]$/, ''));
      }
    });

    // 3. Acceptance チェックボックス
    form.querySelectorAll('.wpcf7-acceptance input[type="checkbox"]').forEach((chk) => {
      if (chk.name) reqSet.add(chk.name.replace(/\[\]$/, ''));
    });

    return Array.from(reqSet);
  }

  /**
   * Contact Form 7 互換ハンドラー
   */
  function attachCf7Handler(form) {
    if (form.__wp_static_initialized) return;
    form.__wp_static_initialized = true;

    const endpoint = getApiEndpoint(form);

    // ブラウザ標準のHTML5ポップアップを無効化してCF7のスタイル付きエラーを使用
    form.setAttribute('novalidate', 'novalidate');
    form.noValidate = true;

    // action を書き換え
    form.setAttribute('action', endpoint);
    form.setAttribute('method', 'POST');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();

      const submitBtn = form.querySelector('input[type="submit"], button[type="submit"]');
      const spinner = form.querySelector('.wpcf7-spinner') || createSpinner(form);
      const responseBox = form.querySelector('.wpcf7-response-output') || createResponseBox(form);

      // 以前のエラー表示をクリア
      form.querySelectorAll('.wpcf7-not-valid-tip').forEach((tip) => tip.remove());
      form.querySelectorAll('.wpcf7-not-valid').forEach((el) => {
        el.classList.remove('wpcf7-not-valid');
        el.removeAttribute('aria-invalid');
      });
      responseBox.style.display = 'none';
      responseBox.className = 'wpcf7-response-output';

      // 1. クライアントサイド事前バリデーション (SWV + DOM Fallback)
      const clientErrors = validateFormLocally(form);
      if (clientErrors.length > 0) {
        form.classList.remove('submitting');
        form.classList.add('failed');
        responseBox.classList.add('wpcf7-validation-errors');
        responseBox.textContent = '入力内容に問題があります。確認して再度お試しください。';
        responseBox.style.display = 'block';

        clientErrors.forEach((err) => {
          setFieldError(form, err.field, err.message);
        });

        const firstErrEl = findFieldElement(form, clientErrors[0].field);
        if (firstErrEl && typeof firstErrEl.focus === 'function') {
          firstErrEl.focus();
        }

        const invalidEvent = new CustomEvent('wpcf7invalid', {
          bubbles: true,
          detail: { form, errors: clientErrors },
        });
        form.dispatchEvent(invalidEvent);
        document.dispatchEvent(invalidEvent);
        return;
      }

      // UI 状態: 送信中
      form.classList.add('submitting');
      if (spinner) spinner.style.visibility = 'visible';
      if (submitBtn) submitBtn.disabled = true;

      try {
        const formData = new FormData(form);

        // 送信元メタ情報付与
        formData.append('_source_url', window.location.href);

        // 必須フィールドの一覧を収集してサーバーに通知
        const reqFields = collectRequiredFields(form);
        if (reqFields.length > 0) {
          formData.append('_required_fields', reqFields.join(','));
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
          headers: {
            'Accept': 'application/json',
          },
        });

        const data = await response.json();

        // CF7 レスポンスに応じたUI反映
        if (data.status === 'mail_sent' || (data.success && !data.errors)) {
          form.classList.remove('submitting');
          form.classList.remove('failed');
          form.classList.add('sent');
          responseBox.classList.add('wpcf7-mail-sent-ok');
          responseBox.textContent = data.message || 'ありがとうございます。メッセージは送信されました。';
          responseBox.style.display = 'block';
          form.reset();

          // Contact Form 7 標準 DOM イベントを発火
          const cf7Event = new CustomEvent('wpcf7mailsent', {
            bubbles: true,
            detail: { form, response: data },
          });
          form.dispatchEvent(cf7Event);
          document.dispatchEvent(cf7Event);

          // リダイレクト設定がある場合は自動遷移 (属性 > input値 > metaタグ > API応答)
          const redirectUrl =
            form.getAttribute('data-redirect-url') ||
            form.getAttribute('data-redirect') ||
            form.querySelector('input[name="_redirect_url"]')?.value ||
            form.querySelector('input[name="_redirect"]')?.value ||
            document.querySelector('meta[name="wp-static-form-redirect"]')?.getAttribute('content') ||
            data.redirect_url ||
            data.redirect;

          if (redirectUrl) {
            setTimeout(function () {
              window.location.href = redirectUrl;
            }, 600);
          }
        } else {
          // validation_failed または mail_failed
          form.classList.remove('submitting');
          form.classList.add('failed');
          responseBox.classList.add('wpcf7-validation-errors');
          responseBox.textContent = data.message || '入力内容に問題があります。確認して再度お試しください。';
          responseBox.style.display = 'block';

          // フィールドごとのエラー表示
          if (Array.isArray(data.invalid_fields)) {
            data.invalid_fields.forEach((field) => {
              setFieldError(form, field.field, field.message);
            });

            if (data.invalid_fields[0]) {
              const firstErr = findFieldElement(form, data.invalid_fields[0].field);
              if (firstErr && typeof firstErr.focus === 'function') firstErr.focus();
            }
          }

          const invalidEvent = new CustomEvent('wpcf7invalid', {
            bubbles: true,
            detail: { form, response: data },
          });
          form.dispatchEvent(invalidEvent);
          document.dispatchEvent(invalidEvent);
        }
      } catch (err) {
        console.error('[wp-static-form] Submit error:', err);
        form.classList.remove('submitting');
        form.classList.add('failed');
        responseBox.classList.add('wpcf7-mail-failed');
        responseBox.textContent = '通信エラーが発生しました。インターネット接続を確認の上、再度お試しください。';
        responseBox.style.display = 'block';
      } finally {
        if (spinner) spinner.style.visibility = 'hidden';
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  /**
   * カスタムフォームハンドラー (MW WP Form / 汎用フォーム)
   */
  function attachCustomHandler(form) {
    if (form.__wp_static_initialized) return;
    form.__wp_static_initialized = true;

    const endpoint = getApiEndpoint(form);

    form.setAttribute('novalidate', 'novalidate');
    form.noValidate = true;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();

      // クライアント事前検証
      const clientErrors = validateFormLocally(form);
      if (clientErrors.length > 0) {
        alert(clientErrors[0].message);
        const el = findFieldElement(form, clientErrors[0].field);
        if (el && typeof el.focus === 'function') el.focus();
        return;
      }

      const submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const formData = new FormData(form);
        formData.append('_source_url', window.location.href);

        const reqFields = collectRequiredFields(form);
        if (reqFields.length > 0) {
          formData.append('_required_fields', reqFields.join(','));
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
          headers: { 'Accept': 'application/json' },
        });

        const data = await response.json();
        if (response.ok && data.success) {
          const redirectUrl =
            form.getAttribute('data-redirect-url') ||
            form.getAttribute('data-redirect') ||
            form.querySelector('input[name="_redirect_url"]')?.value ||
            form.querySelector('input[name="_redirect"]')?.value ||
            document.querySelector('meta[name="wp-static-form-redirect"]')?.getAttribute('content') ||
            data.redirect_url ||
            data.redirect;

          if (redirectUrl) {
            window.location.href = redirectUrl;
          } else {
            alert(data.message || '送信が完了しました。');
            form.reset();
          }
        } else {
          alert('エラー: ' + (data.message || '送信に失敗しました。'));
        }
      } catch (err) {
        alert('通信エラーが発生しました。');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  function createSpinner(form) {
    const span = document.createElement('span');
    span.className = 'wpcf7-spinner';
    span.style.visibility = 'hidden';
    form.appendChild(span);
    return span;
  }

  function createResponseBox(form) {
    const div = document.createElement('div');
    div.className = 'wpcf7-response-output';
    div.style.display = 'none';
    form.appendChild(div);
    return div;
  }

  // DOMContentLoaded で初期化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initForms);
  } else {
    initForms();
  }
})();

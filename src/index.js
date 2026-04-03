import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    // === 环境变量配置区 ===
    const tgBotToken = env.TG_BOT_TOKEN;
    const tgChatId = env.TG_CHAT_ID;
    const geminiApiKey = env.GEMINI_API_KEY;
    
    // 灵活配置：允许通过 env 注入自定义模型和反代 URL。如果不填，默认使用官方直连和 1.5-flash
    const geminiModel = env.GEMINI_MODEL || "gemini-1.5-flash"; 
    const geminiApiBase = env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models/";

    try {
      // 1. 解析邮件
      const parser = new PostalMime();
      const email = await parser.parse(message.raw);

      // 2. 提取收发件人
      let myOriginalEmail = message.to;
      if (email.to && email.to.length > 0) {
        myOriginalEmail = email.to[0].address; 
      }
      const fromName = email.from?.name || "未知发件人";
      const fromEmail = email.from?.address || "未知邮箱";
      const subject = email.subject || "无主题";
      
      const bodyContent = email.text || email.html || "无正文内容";
      const decodedBody = bodyContent.substring(0, 3000); 

      // 3. 附件预检 (防 OOM 内存溢出)
      const validAttachments = (email.attachments || []).filter(att => {
        return att.content.byteLength > 2048 && att.content.byteLength < 15 * 1024 * 1024; 
      });
      const hasAttachment = validAttachments.length > 0;
      let attachmentPrompt = hasAttachment ? `（提醒：邮件包含 ${validAttachments.length} 个有效附件，请在摘要说明）` : "";

      // 4. 请求 AI 处理
      const aiUrl = `${geminiApiBase}${geminiModel}:generateContent?key=${geminiApiKey}`;
      const aiPayload = {
        contents: [{
          parts: [{
            text: `严格以纯JSON格式返回，不要Markdown：
{
  "is_promo": boolean, 
  "is_renewal": boolean, 
  "code": "string", 
  "link": "string", 
  "summary": "string" 
}
邮件内容：\n主题: ${subject}\n发件人: ${fromName}\n内容: ${decodedBody}\n${attachmentPrompt}`
          }]
        }]
      };

      const aiResponse = await fetch(aiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(aiPayload) });
      const aiData = await aiResponse.json();
      let aiText = (aiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}").replace(/```json/gi, '').replace(/```/g, '').trim();
      
      let parsedAI = { is_promo: false, is_renewal: false, code: "", link: "", summary: "解析失败" };
      try { parsedAI = JSON.parse(aiText); } catch (e) {}

      if (parsedAI.is_promo === true) return; // 广告静默丢弃

      // 5. 推送纯文本摘要
      let tgMsg = parsedAI.is_renewal ? `❗❗❗ <b>【续费/到期提醒】</b> ❗❗❗\n\n` : `📧 <b>新邮件到达</b>\n\n`;
      tgMsg += `🎯 <b>接收:</b> <code>${myOriginalEmail}</code>\n`; 
      tgMsg += `👤 <b>发件:</b> ${fromName} (<code>${fromEmail}</code>)\n`; 
      tgMsg += `📝 <b>主题:</b> ${subject}\n\n`;
      if (parsedAI.code && parsedAI.code.length < 15) tgMsg += `🔑 <b>验证码:</b> <code>${parsedAI.code}</code>\n\n`;
      tgMsg += `🤖 <b>AI摘要:</b>\n${parsedAI.summary}`;

      let reply_markup = {};
      if (parsedAI.link) reply_markup = { inline_keyboard: [[{ text: "🔗 快捷跳转 / 确认操作", url: parsedAI.link }]] };

      await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: tgChatId, 
          text: tgMsg, 
          parse_mode: "HTML", 
          link_preview_options: { is_disabled: true }, // 使用 Telegram 最新规范关闭链接预览
          reply_markup: Object.keys(reply_markup).length > 0 ? reply_markup : undefined 
        })
      });

      // 6. 推送附件
      if (hasAttachment) {
        const maxAttachments = Math.min(validAttachments.length, 3);
        for (let i = 0; i < maxAttachments; i++) {
          const file = validAttachments[i];
          const formData = new FormData();
          formData.append("chat_id", tgChatId);
          formData.append("document", new Blob([file.content], { type: file.mimeType }), file.filename || `attachment_${i+1}`);

          await fetch(`https://api.telegram.org/bot${tgBotToken}/sendDocument`, {
            method: "POST",
            body: formData
          });
        }
      }

    } catch (error) {
      console.error(error);
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: `❌ Worker 错误: ${error.message}` })
      });
    }
  }
}
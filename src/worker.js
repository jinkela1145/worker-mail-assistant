import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    // === 环境变量配置区 ===
    const tgBotToken = env.TG_BOT_TOKEN;
    const tgChatId = env.TG_CHAT_ID;
    const geminiApiKey = env.GEMINI_API_KEY;
    
    // 灵活配置：允许通过 env 注入自定义模型和反代 URL
    const geminiModel = env.GEMINI_MODEL || "gemini-1.5-flash"; 
    const geminiApiBase = env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models/";

    try {
      // 1. 解析邮件
      const parser = new PostalMime();
      const email = await parser.parse(message.raw);

      // 2. 提取收发件人信息
      let myOriginalEmail = message.to;
      if (email.to && email.to.length > 0) {
        myOriginalEmail = email.to[0].address; 
      }
      const fromName = email.from?.name || "未知发件人";
      const fromEmail = email.from?.address || "未知邮箱";
      const subject = email.subject || "无主题";
      
      const bodyContent = email.text || email.html || "无正文内容";
      const decodedBody = bodyContent.substring(0, 3000); 

      // 3. 附件分类预检 (防 OOM 内存溢出)
      const allAttachments = email.attachments || [];
      const validAttachments = [];    // 准备转发的附件 (<15MB)
      const oversizedAttachments = []; // 超大附件 (>15MB)
      
      for (const att of allAttachments) {
        const size = att.content.byteLength;
        if (size >= 15 * 1024 * 1024) {
          oversizedAttachments.push(att);
        } else if (size > 2048) { // 过滤掉小于 2KB 的图标
          validAttachments.push(att);
        }
      }

      const hasValid = validAttachments.length > 0;
      const hasOversized = oversizedAttachments.length > 0;
      
      // 动态生成给 AI 的提示词
      let attachmentPrompt = "";
      if (hasValid) attachmentPrompt += `（提醒：邮件包含 ${validAttachments.length} 个可转发附件，请在摘要中提及）`;
      if (hasOversized) attachmentPrompt += `（提醒：邮件包含 ${oversizedAttachments.length} 个超过15MB的超大附件，请在摘要末尾加上『📎 包含超大附件，请打开邮箱查看』）`;

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
邮件内容：
主题: ${subject}
发件人: ${fromName}
内容: ${decodedBody}
${attachmentPrompt}

🚨 摘要生成特别指令：
1. 如果是往来回复的邮件，必须使用句式：“针对【上一句原文核心内容】，对方回复了：【最新回复内容】”。
2. 如果是普通新邮件，则正常总结。`
          }]
        }]
      };

      const aiResponse = await fetch(aiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(aiPayload) });
      const aiData = await aiResponse.json();
      let aiText = (aiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}").replace(/```json/gi, '').replace(/```/g, '').trim();
      
      let parsedAI = { is_promo: false, is_renewal: false, code: "", link: "", summary: "解析失败" };
      try { parsedAI = JSON.parse(aiText); } catch (e) {}

      if (parsedAI.is_promo === true) return; 

      // 5. 构建并推送 Telegram 文字消息
      let tgMsg = parsedAI.is_renewal ? `❗❗❗ <b>【续费/到期提醒】</b> ❗❗❗\n\n` : `📧 <b>新邮件到达</b>\n\n`;
      tgMsg += `🎯 <b>接收:</b> <code>${myOriginalEmail}</code>\n`; 
      tgMsg += `👤 <b>发件:</b> ${fromName} (<code>${fromEmail}</code>)\n`; 
      tgMsg += `📝 <b>主题:</b> ${subject}\n\n`;
      if (parsedAI.code && parsedAI.code.length < 15) tgMsg += `🔑 <b>验证码:</b> <code>${parsedAI.code}</code>\n\n`;
      tgMsg += `🤖 <b>AI摘要:</b>\n${parsedAI.summary}`;

      // 如果有超大附件，在消息末尾显眼标记
      if (hasOversized) {
        tgMsg += `\n\n⚠️ <b>超大附件提醒:</b>\n检测到 ${oversizedAttachments.length} 个附件超过 15MB，Worker 无法直接转发，请务必登录原邮箱查看详情。`;
      }

      let reply_markup = {};
      if (parsedAI.link) reply_markup = { inline_keyboard: [[{ text: "🔗 快捷跳转 / 确认操作", url: parsedAI.link }]] };

      await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: tgChatId, 
          text: tgMsg, 
          parse_mode: "HTML", 
          link_preview_options: { is_disabled: true }, 
          reply_markup: Object.keys(reply_markup).length > 0 ? reply_markup : undefined 
        })
      });

      // 6. 推送可转发的附件
      if (hasValid) {
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
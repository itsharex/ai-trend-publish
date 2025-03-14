import { DeepseekAPI } from "@src/api/deepseek.api.ts";
import { getCronSources } from "@src/data-sources/getCronSources.ts";
import { ContentRanker } from "@src/modules/content-rank/ai.content-ranker.ts";
import { RankResult } from "@src/modules/interfaces/content-ranker.interface.ts";
import { ContentPublisher } from "@src/modules/interfaces/publisher.interface.ts";
import { ContentScraper, ScrapedContent } from "@src/modules/interfaces/scraper.interface.ts";
import { ContentSummarizer } from "@src/modules/interfaces/summarizer.interface.ts";
import { BarkNotifier } from "@src/modules/notify/bark.notify.ts";
import { WeixinPublisher } from "@src/modules/publishers/weixin.publisher.ts";
import { WeixinTemplate } from "@src/modules/render/interfaces/article.type.ts";
import { FireCrawlScraper } from "@src/modules/scrapers/fireCrawl.scraper.ts";
import { TwitterScraper } from "@src/modules/scrapers/twitter.scraper.ts";
import { AISummarizer } from "@src/modules/summarizer/ai.summarizer.ts";
import cliProgress from "npm:cli-progress";
import { ImageGeneratorFactory } from "@src/providers/image-gen/image-generator-factory.ts";
import { WeixinImageProcessor } from "@src/utils/image/image-processor.ts";
import { ConfigManager } from "@src/utils/config/config-manager.ts";
import { WeixinArticleTemplateRenderer } from "@src/modules/render/article.renderer.ts";

export class WeixinWorkflow {
  private scraper: Map<string, ContentScraper>;
  private summarizer: ContentSummarizer;
  private publisher: ContentPublisher;
  private notifier: BarkNotifier;
  private renderer: WeixinArticleTemplateRenderer;
  private deepSeekClient: DeepseekAPI;
  private contentRanker: ContentRanker;
  private stats = {
    success: 0,
    failed: 0,
    contents: 0,
  };

  constructor() {
    this.scraper = new Map<string, ContentScraper>();
    this.scraper.set("fireCrawl", new FireCrawlScraper());
    this.scraper.set("twitter", new TwitterScraper());
    this.summarizer = new AISummarizer();
    this.publisher = new WeixinPublisher();
    this.notifier = new BarkNotifier();
    this.renderer = new WeixinArticleTemplateRenderer();
    this.deepSeekClient = new DeepseekAPI();
    this.contentRanker = new ContentRanker();
  }


  private async scrapeSource(
    type: string,
    source: { identifier: string },
    scraper: ContentScraper
  ): Promise<ScrapedContent[]> {
    try {
      console.log(`[${type}] 抓取: ${source.identifier}`);
      const contents = await scraper.scrape(source.identifier);

      this.stats.success++;
      return contents;
    } catch (error) {
      this.stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${type}] ${source.identifier} 抓取失败:`, message);
      await this.notifier.warning(
        `${type}抓取失败`,
        `源: ${source.identifier}\n错误: ${message}`
      );
      return [];
    }
  }

  private async processContent(content: ScrapedContent): Promise<void> {
    try {
      const summary = await this.summarizer.summarize(JSON.stringify(content));
      content.title = summary.title;
      content.content = summary.content;
      content.metadata.keywords = summary.keywords;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[内容处理] ${content.id} 处理失败:`, message);
      await this.notifier.warning(
        "内容处理失败",
        `ID: ${content.id}\n保留原始内容`
      );
      content.title = content.title || "无标题";
      content.content = content.content || "内容处理失败";
      content.metadata.keywords = content.metadata.keywords || [];
    }
  }

  async process(): Promise<void> {
    try {
      console.log("=== 开始执行微信工作流 ===");
      await this.notifier.info("工作流开始", "开始执行内容抓取和处理");

      // 检查 API 额度
      // deepseek
      const deepSeekBalance = await this.deepSeekClient.getCNYBalance();
      console.log("DeepSeek余额：", deepSeekBalance);
      if (deepSeekBalance < 1.0) {
        this.notifier.warning("DeepSeek", "余额小于一元");
      }
      // 1. 获取数据源
      const sourceConfigs = await getCronSources();

      const sourceIds = sourceConfigs.AI;
      const totalSources =
        sourceIds.firecrawl.length + sourceIds.twitter.length;
      console.log(`[数据源] 发现 ${totalSources} 个数据源`);

      const progress = new cliProgress.SingleBar(
        {},
        cliProgress.Presets.shades_classic
      );
      progress.start(totalSources, 0);
      let currentProgress = 0;

      // 2. 抓取内容
      let allContents: ScrapedContent[] = [];

      // FireCrawl sources
      const fireCrawlScraper = this.scraper.get("fireCrawl");
      if (!fireCrawlScraper) throw new Error("FireCrawlScraper not found");

      for (const source of sourceIds.firecrawl) {
        const contents = await this.scrapeSource(
          "FireCrawl",
          source,
          fireCrawlScraper
        );
        allContents.push(...contents);
        progress.update(++currentProgress);
      }

      // Twitter sources
      const twitterScraper = this.scraper.get("twitter");
      if (!twitterScraper) throw new Error("TwitterScraper not found");

      for (const source of sourceIds.twitter) {
        const contents = await this.scrapeSource(
          "Twitter",
          source,
          twitterScraper
        );
        allContents.push(...contents);
        progress.update(++currentProgress);
      }
      progress.stop();

      this.stats.contents = allContents.length;
      if (this.stats.contents === 0) {
        const message = "未获取到任何内容";
        console.error(`[工作流] ${message}`);
        await this.notifier.error("工作流终止", message);
        return;
      }

      // 3. 内容排序
      console.log(`[内容排序] 开始排序 ${allContents.length} 条内容`);
      let rankedContents: RankResult[] = [];
      try {
        rankedContents = await this.contentRanker.rankContents(allContents);
        console.log("内容排序完成", rankedContents);
      } catch (error) {
        console.error("内容排序失败:", error);
        await this.notifier.error("内容排序失败", "请检查API额度");
      }

      // 分数更新和过滤
      console.log(`[分数更新] 开始更新和过滤内容`);
      if (rankedContents.length > 0) {
        // 只保留有分数的内容
        allContents = allContents.filter(content => {
          const rankedContent = rankedContents.find(
            (ranked) => ranked.id === content.id
          );
          if (rankedContent) {
            content.score = rankedContent.score;
            return true;
          }
          return false;
        });
        console.log(`[过滤结果] 剩余 ${allContents.length} 条有分数的内容`);
      } else {
        console.log("[警告] 没有任何内容被评分");
      }

      // 按照score排序
      allContents.sort((a, b) => b.score - a.score);

      // 只取前ARTICLE_NUM条内容进行处理
      const topContents = allContents.slice(0, await ConfigManager.getInstance().get("ARTICLE_NUM"));

      // 4. 内容处理 (只处理排序后的前10条)
      console.log(`\n[内容处理] 处理排序后的前 ${topContents.length} 条内容`);
      const summaryProgress = new cliProgress.SingleBar(
        {},
        cliProgress.Presets.shades_classic
      );
      summaryProgress.start(topContents.length, 0);

      // 批量处理内容
      const batchSize = 10;
      for (let i = 0; i < topContents.length; i += batchSize) {
        const batch = topContents.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (content) => {
            await this.processContent(content);
            summaryProgress.increment();
          })
        );
      }
      summaryProgress.stop();

      // 5. 生成并发布
      console.log("\n[模板生成] 生成微信文章");
      const templateData: WeixinTemplate[] = topContents.map((content) => ({
        id: content.id,
        title: content.title,
        content: content.content,
        url: content.url,
        publishDate: content.publishDate,
        metadata: content.metadata,
        keywords: content.metadata.keywords,
        media: content.media,
      }));

      console.debug("templateData", JSON.stringify(templateData, null, 2));

      // 将所有标题总结成一个标题，然后让AI生成一个最具有吸引力的标题
      const summaryTitle = await this.summarizer.generateTitle(
        allContents.map((content) => content.title).join(" | ")
      ).then((title) => {
        title = `${new Date().toLocaleDateString()} AI速递 | ${title}`
        // 限制标题长度 为 64 个字符
        return title.slice(0, 64);
      });

      console.log(`[标题生成] 生成标题: ${summaryTitle}`);

      // 生成封面图片
      const imageGenerator = await ImageGeneratorFactory.getInstance().getGenerator("ALIWANX_POSTER");
      const imageUrl = await imageGenerator.generate({
        title: summaryTitle.split(" | ")[1].trim().slice(0, 30),
        sub_title: new Date().toLocaleDateString() + " AI速递",
        prompt_text_zh: `科技前沿资讯 | 人工智能新闻 | 每日AI快报 - ${summaryTitle.split(" | ")[1].trim().slice(0, 30)}`,
        generate_mode: "generate",
        generate_num: 1
      });

      // 上传封面图片
      const mediaId = await this.publisher.uploadImage(imageUrl);

      const renderedTemplate = await this.renderer.render(templateData);
      console.log("[发布] 发布到微信公众号");
      const publishResult = await this.publisher.publish(
        renderedTemplate,
        summaryTitle,
        summaryTitle,
        mediaId
      );

      // 5. 完成报告
      const summary = `
        工作流执行完成
        - 数据源: ${totalSources} 个
        - 成功: ${this.stats.success} 个
        - 失败: ${this.stats.failed} 个
        - 内容: ${this.stats.contents} 条
        - 发布: ${publishResult.status}`.trim();

      console.log(`=== ${summary} ===`);

      if (this.stats.failed > 0) {
        await this.notifier.warning("工作流完成(部分失败)", summary);
      } else {
        await this.notifier.success("工作流完成", summary);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[工作流] 执行失败:", message);
      await this.notifier.error("工作流失败", message);
      throw error;
    }
  }
}

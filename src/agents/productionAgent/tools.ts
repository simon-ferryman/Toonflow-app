import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";

const deriveAssetSchema = z.object({
  id: z.number().describe("教学衍生素材ID,如果新增则为空"),
  assetsId: z.number().describe("关联的基础教学素材ID"),
  prompt: z.string().describe("教学衍生素材生成提示词"),
  name: z.string().describe("教学衍生素材名称"),
  desc: z.string().describe("教学衍生素材描述，应说明该状态或步骤所表达的知识内容"),
  src: z.string().nullable().describe("教学衍生素材资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("教学衍生素材生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("教学素材主类型：role为讲师或人物，tool为公式、图表、地图、示意图或实验器材，scene为教学或知识场景，clip为动画、屏幕录制或视频片段"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("教学素材唯一标识"),
  name: z.string().describe("教学素材名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("教学素材主类型：role为讲师或人物，tool为公式、图表、地图、示意图或实验器材，scene为教学或知识场景，clip为动画、屏幕录制或视频片段"),
  prompt: z.string().describe("教学素材生成提示词"),
  desc: z.string().describe("教学素材描述，应说明素材呈现的内容及其教学用途"),
  derive: z.array(deriveAssetSchema).describe("教学衍生素材列表"),
});
const storyboardSchema = z.object({
  id: z.number().describe("教学分镜ID，必须为真实id"),
  duration: z.number().describe("教学分镜持续时长(秒)"),
  prompt: z.string().describe("教学分镜图片生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联教学素材ID列表"),
  src: z.string().nullable().describe("教学分镜资源路径"),
  index: z.number().nullable().optional().describe("教学分镜排序字段"),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("课程讲解脚本"),
  scriptPlan: z.string().describe("视觉教学方案"),
  assets: z.array(assetItemSchema).describe("教学素材及衍生素材"),
  storyboardTable: z.string().describe("教育视频分镜表"),
  storyboard: z.array(storyboardSchema).describe("教学画面分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const keySchema = z.enum(Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>]);
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

/**
 * 串行队列：确保 socket 操作排队执行，避免并发过高导致假死
 * @param delayMs 每个操作之间的最小间隔(ms)
 */
function createSocketQueue(delayMs = 800) {
  let lastPromise: Promise<any> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    lastPromise = lastPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          setTimeout(() => fn().then(resolve, reject), delayMs);
        }),
    );
    return lastPromise;
  };
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const socketQueue = createSocketQueue(800);
  const workMap: Record<any, any> = {};
  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "获取教育视频生产工作区数据",
      inputSchema: jsonSchema<{ key: keyof FlowData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[key]}工作区数据...`);

        const flowData: FlowData = await new Promise((resolve) => socket.emit("getFlowData", { key }, (res: any) => resolve(res)));
        thinking.appendText(`获取到${flowDataKeyLabels[key]}:\n` + JSON.stringify(flowData[key], null, 2));
        thinking.updateTitle(`获取${flowDataKeyLabels[key]}完成`);
        thinking.complete();
        if (workMap[key] && JSON.stringify(workMap[key]) === JSON.stringify(flowData[key])) {
          console.info(`[tools] get_flowData: ${flowDataKeyLabels[key]}数据未变化，无需更新`);
          return `${flowDataKeyLabels[key]}数据未变化，无需更新`;
        }
        workMap[key] = flowData[key];
        return flowData[key];
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新教学衍生素材，例如公式推导状态、图表数据状态、地图标注状态、实验步骤或人物动作状态",
      inputSchema: jsonSchema<{ assetsId: number; id: number | null; name: string; desc: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的基础教学素材ID"),
            id: z.number().nullable().describe("教学衍生素材ID,如果新增则为空"),
            name: z.string().describe("教学衍生素材名称"),
            desc: z.string().describe("教学衍生素材描述，应说明该状态或步骤所表达的知识内容"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        // 容错：LLM 偶尔传 "null" 字符串或空串，统一规范为 null
        const idRaw = raw.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined ? null : (idRaw as number | null);
        const deriveAsset = { ...raw, id: normalizedId };

        const thinking = msg.thinking("正在操作教学素材...");
        const { projectId, scriptId } = resTool.data;
        const startTime = Date.now();
        const parentAssets = await u.db("o_assets").where("id", deriveAsset.assetsId).select("id", "type").first();
        if (!parentAssets) return "关联的资产素材不存在";

        const data = {
          id: deriveAsset.id ?? undefined,
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
          startTime,
        };
        if (deriveAsset.id) {
          await u.db("o_assets").where("id", deriveAsset.id).update(data);
          thinking.appendText(`已更新教学衍生素材，ID: ${deriveAsset.id}\n`);
        } else {
          const [insertedId] = await u.db("o_assets").insert(data);
          data.id = insertedId;
          await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
          thinking.appendText(`已新增教学衍生素材，ID: ${insertedId}\n`);
        }
        const res = await new Promise((resolve) => socket.emit("addDeriveAsset", data, (res: any) => resolve(res)));
        thinking.updateTitle("教学素材操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除教学衍生素材",
      inputSchema: jsonSchema<{ assetsId: number; id: number }>(
        z
          .object({
            assetsId: z.number().describe("关联的基础教学素材ID"),
            id: z.number().describe("教学衍生素材ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作教学素材...");
        const { scriptId } = resTool.data;
        await u.db("o_assets").where("id", id).del();
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        thinking.appendText(`已删除教学衍生素材，ID: ${id}\n`);
        const res = await new Promise((resolve) => socket.emit("delDeriveAsset", { assetsId, id }, (res: any) => resolve(res)));
        thinking.updateTitle("教学素材操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "生成教学衍生素材图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的教学衍生素材ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成教学衍生素材...");
        new Promise((resolve) => socket.emit("generateDeriveAsset", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText(`已生成教学衍生素材，ID: ${JSON.stringify(res, null, 2)}\n`);
            thinking.updateTitle("教学衍生素材开始完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("教学衍生素材生成失败:\n" + u.error(e).message);
            thinking.updateTitle("教学衍生素材生成失败");
            thinking.complete();
          });

        return "开始生成教学衍生素材";
      },
    }),
    generate_storyboard: tool({
      description: "生成教学分镜图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的教学分镜ID，支持批量生成"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成教学分镜...");
        socketQueue(
          () =>
            new Promise((resolve, reject) =>
              socket.emit("generateStoryboard", { ids }, (res: any) => {
                if (res?.error) return reject(new Error(res.error));
                resolve(res);
              }),
            ),
        )
          .then((res) => {
            thinking.appendText("生成的教学分镜数据:\n" + JSON.stringify(res, null, 2));
            thinking.updateTitle("教学分镜生成完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("教学分镜生成失败:\n" + u.error(e).message);
            thinking.updateTitle("教学分镜生成失败");
            thinking.complete();
          });

        return "开始生成教学分镜";
      },
    }),
    add_flowData_storyboard: tool({
      description: "新增教学画面分镜面板到工作区",
      inputSchema: jsonSchema<{
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[] | null;
        shouldGenerateImage: string;
      }>(
        z
          .object({
            videoDesc: z.string().describe("教学分镜完整描述，使用现有字符串承载学习目标、知识点、资料依据、旁白、屏幕文字、视觉目的、画面描述、场景、关联素材名称、时长、景别、运镜、音效和关联素材ID"),
            prompt: z.string().nullable().describe("教学分镜图片提示词"),
            track: z.string().describe("教学分镜分组"),
            duration: z.number().describe("教学视频推荐时长"),
            associateAssetsIds: z.array(z.number()).nullable().describe("该教学分镜所需的素材ID列表"),
            shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成教学分镜图片"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        const thinking = msg.thinking("正在新增教学画面分镜面板数据...");
        const data = {
          videoDesc: raw.videoDesc,
          prompt: raw.prompt,
          track: raw.track,
          duration: raw.duration,
          associateAssetsIds: raw.associateAssetsIds ?? [],
          shouldGenerateImage: raw.shouldGenerateImage,
        };
        socketQueue(
          () =>
            new Promise((resolve, reject) =>
              socket.emit("addStoryboard", { ...data }, (res: any) => {
                if (res?.error) return reject(new Error(res.error));
                resolve(res);
              }),
            ),
        )
          .then((res) => {
            thinking.appendText("新增的教学分镜数据:\n" + JSON.stringify(data, null, 2));
            thinking.updateTitle("新增教学分镜成功");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("新增的教学分镜数据:\n" + JSON.stringify(data, null, 2));
            thinking.updateTitle("新增教学分镜失败");
            thinking.complete();
          });
        return true;
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};

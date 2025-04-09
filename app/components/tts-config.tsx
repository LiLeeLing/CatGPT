import { TTSConfig, TTSConfigValidator } from "../store";

import Locale from "../locales";
import { ListItem, Select } from "./ui-lib";
import {
  DEFAULT_TTS_ENGINE,
  DEFAULT_TTS_ENGINES,
  DEFAULT_TTS_MODELS,
  DEFAULT_TTS_VOICES,
  DEFAULT_EDGE_TTS_VOICES, // <--- 导入 Edge 声音列表
} from "../constant";
import { InputRange } from "./input-range";

export function TTSConfigList(props: {
  ttsConfig: TTSConfig;
  updateConfig: (updater: (config: TTSConfig) => void) => void;
}) {
  return (
    <>
      <ListItem
        title={Locale.Settings.TTS.Enable.Title}
        subTitle={Locale.Settings.TTS.Enable.SubTitle}
      >
        <input
          aria-label={Locale.Settings.TTS.Enable.Title}
          type="checkbox"
          checked={props.ttsConfig.enable}
          onChange={(e) =>
            props.updateConfig(
              (config) => (config.enable = e.currentTarget.checked),
            )
          }
        ></input>
      </ListItem>

      {/* 只有在 TTS 启用时才显示后续选项 */}
      {props.ttsConfig.enable && (
        <>
          {/* Autoplay 选项 (如果需要，取消注释) */}
          {/* <ListItem
            title={Locale.Settings.TTS.Autoplay.Title}
            subTitle={Locale.Settings.TTS.Autoplay.SubTitle}
          >
            <input
              type="checkbox"
              checked={props.ttsConfig.autoplay}
              onChange={(e) =>
                props.updateConfig(
                  (config) => (config.autoplay = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem> */}

          {/* TTS 引擎选择 */}
          <ListItem title={Locale.Settings.TTS.Engine}>
            <Select
              aria-label={Locale.Settings.TTS.Engine}
              value={props.ttsConfig.engine}
              onChange={(e) => {
                props.updateConfig(
                  (config) =>
                    (config.engine = TTSConfigValidator.engine(
                      e.currentTarget.value,
                    )),
                );
              }}
            >
              {DEFAULT_TTS_ENGINES.map((v, i) => (
                <option value={v} key={i}>
                  {v}
                </option>
              ))}
            </Select>
          </ListItem>

          {/* OpenAI TTS 特定选项 */}
          {props.ttsConfig.engine === DEFAULT_TTS_ENGINE && (
            <>
              <ListItem title={Locale.Settings.TTS.Model}>
                <Select
                  aria-label={Locale.Settings.TTS.Model}
                  value={props.ttsConfig.model}
                  onChange={(e) => {
                    props.updateConfig(
                      (config) =>
                        (config.model = TTSConfigValidator.model(
                          e.currentTarget.value,
                        )),
                    );
                  }}
                >
                  {DEFAULT_TTS_MODELS.map((v, i) => (
                    <option value={v} key={i}>
                      {v}
                    </option>
                  ))}
                </Select>
              </ListItem>
              <ListItem
                title={Locale.Settings.TTS.Voice.Title}
                subTitle={Locale.Settings.TTS.Voice.SubTitle}
              >
                <Select
                  aria-label={Locale.Settings.TTS.Voice.Title}
                  value={props.ttsConfig.voice}
                  onChange={(e) => {
                    props.updateConfig(
                      (config) =>
                        (config.voice = TTSConfigValidator.voice(
                          e.currentTarget.value,
                        )),
                    );
                  }}
                >
                  {DEFAULT_TTS_VOICES.map((v, i) => (
                    <option value={v} key={i}>
                      {v}
                    </option>
                  ))}
                </Select>
              </ListItem>
              {/* Speed 设置移到外面 */}
            </>
          )}

          {/* 新增: Edge TTS 特定选项 */}
          {props.ttsConfig.engine === "Edge-TTS" && (
            <>
              <ListItem
                title={Locale.Settings.TTS.Voice.Title} // 复用标题，或者创建新的 Locale.Settings.TTS.EdgeVoice.Title
                subTitle={Locale.Settings.TTS.Voice.SubTitle} // 复用副标题，或者创建新的
              >
                <Select
                  aria-label={Locale.Settings.TTS.Voice.Title} // 复用 aria-label
                  value={props.ttsConfig.edgeTTSVoiceName}
                  onChange={(e) => {
                    props.updateConfig(
                      (config) =>
                        // 使用验证器或类型断言
                        (config.edgeTTSVoiceName =
                          TTSConfigValidator.edgeTTSVoiceName(
                            e.currentTarget.value,
                          )),
                      // 或者: (config.edgeTTSVoiceName = e.currentTarget.value as TTSEdgeVoiceType)
                    );
                  }}
                >
                  {DEFAULT_EDGE_TTS_VOICES.map((v, i) => (
                    <option value={v} key={i}>
                      {v} {/* 可以考虑显示更友好的名称 */}
                    </option>
                  ))}
                </Select>
              </ListItem>
              {/* 如果 Edge TTS 有独立的 Speed 设置，放在这里 */}
            </>
          )}

          {/* 通用 TTS 设置 (适用于所有引擎) */}
          <ListItem
            title={Locale.Settings.TTS.Speed.Title}
            subTitle={Locale.Settings.TTS.Speed.SubTitle}
          >
            <InputRange
              aria={Locale.Settings.TTS.Speed.Title}
              value={props.ttsConfig.speed?.toFixed(1)}
              min="0.3" // 最小值可以根据需要调整
              max="4.0" // 最大值可以根据需要调整
              step="0.1"
              onChange={(e) => {
                props.updateConfig(
                  (config) =>
                    (config.speed = TTSConfigValidator.speed(
                      e.currentTarget.valueAsNumber,
                    )),
                );
              }}
            ></InputRange>
          </ListItem>
        </>
      )}
    </>
  );
}

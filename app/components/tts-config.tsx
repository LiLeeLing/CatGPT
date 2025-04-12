import { TTSConfig, TTSConfigValidator } from "../store";

import Locale from "../locales";
import { ListItem, Select } from "./ui-lib";
import {
  DEFAULT_TTS_ENGINE,
  DEFAULT_TTS_ENGINES,
  DEFAULT_TTS_MODELS,
  DEFAULT_TTS_VOICES,
  DEFAULT_EDGE_TTS_VOICES,
} from "../constant";
import { InputRange } from "./input-range";
import { PITCH } from "../utils/ms_edge_tts"; // <--- 新增: 导入 PITCH 枚举

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
          {/* Autoplay 选项 */}
          <ListItem
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
          </ListItem>

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
              {/* OpenAI Speed 设置移到通用部分 */}
            </>
          )}

          {/* Edge TTS 特定选项 */}
          {props.ttsConfig.engine === "Edge-TTS" && (
            <>
              <ListItem
                title={Locale.Settings.TTS.Voice.Title} // 复用标题
                subTitle={Locale.Settings.TTS.Voice.SubTitle} // 复用副标题
              >
                <Select
                  aria-label={Locale.Settings.TTS.Voice.Title} // 复用 aria-label
                  value={props.ttsConfig.edgeTTSVoiceName}
                  onChange={(e) => {
                    props.updateConfig(
                      (config) =>
                        (config.edgeTTSVoiceName =
                          TTSConfigValidator.edgeTTSVoiceName(
                            e.currentTarget.value,
                          )),
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

              {/* 新增: Edge TTS 音调选择 */}
              <ListItem
                title={Locale.Settings.TTS.EdgePitch?.Title || "音调"} // 使用 Locale，提供默认值
                subTitle={Locale.Settings.TTS.EdgePitch?.SubTitle || "调整声音的音高"} // 使用 Locale，提供默认值
              >
                <Select
                  aria-label={Locale.Settings.TTS.EdgePitch?.Title || "音调"}
                  value={props.ttsConfig.edgeTTSPitch}
                  onChange={(e) => {
                    props.updateConfig(
                      (config) =>
                        (config.edgeTTSPitch = TTSConfigValidator.edgeTTSPitch( // 使用验证器
                          e.currentTarget.value,
                        ) as PITCH), // <--- 添加类型断言 as PITCH
                    );
                  }}
                >
                  {Object.values(PITCH).map((pitchValue) => (
                    <option key={pitchValue} value={pitchValue}>
                      {/* 显示友好的标签，例如大写首字母 */}
                      {pitchValue.charAt(0).toUpperCase() + pitchValue.slice(1)}
                      {/* 或者使用 Locale.Pitch[pitchValue] 进行翻译 */}
                    </option>
                  ))}
                  {/* 如果需要支持自定义字符串，可以在这里添加逻辑 */}
                </Select>
              </ListItem>
              {/* Edge TTS Speed 设置移到通用部分 */}
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

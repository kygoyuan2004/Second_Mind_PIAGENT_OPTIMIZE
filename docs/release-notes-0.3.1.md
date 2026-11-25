# Second Mind Pi v0.3.1

macOS、Windows、Linux 桌面版和 Docker 的问答输入框现在会显示语音模型状态。首次点击「下载语音模型（约 486 MB）」后可以继续打字提问。下载完成并通过校验后，点击「开始口述」才会使用麦克风。下载中断后可在原处重试，已就绪的模型可离线使用。

桌面版复用已有语音模型。Docker 将新下载的模型保存在实例数据卷中，各知识库共用一份，并可识别此前已完整缓存的相同模型。连接远程工作区时，按钮显示远程服务的状态。

The question composer now shows speech model download progress and supports retry on macOS, Windows, Linux and Docker. Type while the model downloads, then select **开始口述** to record. Existing desktop models and verified Docker caches can be reused offline.

    const statusElement = document.getElementById("status");
    const statusText = document.getElementById("statusText");
    const messageElement = document.getElementById("message");
    const connectButton = document.getElementById("connectButton");
    const disconnectButton = document.getElementById("disconnectButton");
    const logElement = document.getElementById("log");
    const emptyState = document.getElementById("emptyState");
    const byteCounter = document.getElementById("byteCounter");
    const saveButton = document.getElementById("saveButton");
    const controls = [
      document.getElementById("baudRate"),
      document.getElementById("dataBits"),
      document.getElementById("parity"),
      document.getElementById("stopBits"),
      document.getElementById("flowControl")
    ];

    let port = null;
    let reader = null;
    let readTask = null;
    let totalBytes = 0;
    const capturedPackets = [];

    const sopTypes = [
      "SOP",
      "SOP'",
      "SOP''",
      "SOP'_Debug",
      "SOP''_Debug",
      "Cable_Reset",
      "SOP_extension1",
      "SOP_extension2"
    ];

    const usbPdControlMessages = {
      1: "GoodCRC",
      2: "GotoMin",
      3: "Accept",
      4: "Reject",
      5: "Ping",
      6: "PS_RDY",
      7: "Get_Source_Cap",
      8: "Get_Sink_Cap",
      9: "DR_Swap",
      10: "PR_Swap",
      11: "VCONN_Swap",
      12: "Wait",
      13: "Soft_Reset",
      14: "Data_Reset",
      15: "Data_Reset_Complete",
      16: "Not_Supported",
      17: "Get_Source_Cap_Extended",
      18: "Get_Status",
      19: "FR_Swap",
      20: "Get_PPS_Status",
      21: "Get_Country_Codes",
      22: "Get_Sink_Cap_Extended",
      23: "Get_Source_Info",
      24: "Get_Revision"
    };

    const usbPdDataMessages = {
      1: "Source_Capabilities",
      2: "Request",
      3: "BIST",
      4: "Sink_Capabilities",
      5: "Battery_Status",
      6: "Alert",
      7: "Get_Country_Info",
      8: "Enter_USB",
      9: "EPR_Mode",
      10: "Source_Info",
      11: "Revision"
    };

    function formatVoltage(voltage) {
      return `${Number(voltage.toFixed(2))} V`;
    }

    function formatCurrent(current) {
      return `${Number(current.toFixed(2))} A`;
    }

    function formatUsbPdPayload(bytes) {
      const formatBytes = (group) =>
        group.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      if (bytes.length <= 2) return formatBytes(bytes);

      const lines = [formatBytes(bytes.slice(0, 2))];
      for (let offset = 2; offset < bytes.length; offset += 4) {
        lines.push(formatBytes(bytes.slice(offset, offset + 4)));
      }
      return lines.join("\n");
    }

    function decodeUsbPdPdo(value, index) {
      const supplyType = value >>> 30;
      const prefix = `PDO${index} 0x${value.toString(16).padStart(8, "0").toUpperCase()}`;

      if (supplyType === 0) {
        const voltage = ((value >>> 10) & 0x3ff) * 0.05;
        const current = (value & 0x3ff) * 0.01;
        const flags = [
          value & (1 << 29) ? "Dual-Role Power" : "",
          value & (1 << 26) ? "USB Communications" : "",
          value & (1 << 25) ? "Dual-Role Data" : ""
        ].filter(Boolean);
        return `${prefix}: Fixed ${formatVoltage(voltage)}, ${formatCurrent(current)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
      }

      if (supplyType === 1) {
        const maximumVoltage = ((value >>> 20) & 0x3ff) * 0.05;
        const minimumVoltage = ((value >>> 10) & 0x3ff) * 0.05;
        const power = (value & 0x3ff) * 0.25;
        return `${prefix}: Battery ${formatVoltage(minimumVoltage)}–${formatVoltage(maximumVoltage)}, ${Number(power.toFixed(2))} W`;
      }

      if (supplyType === 2) {
        const maximumVoltage = ((value >>> 20) & 0x3ff) * 0.05;
        const minimumVoltage = ((value >>> 10) & 0x3ff) * 0.05;
        const current = (value & 0x3ff) * 0.01;
        return `${prefix}: Variable ${formatVoltage(minimumVoltage)}–${formatVoltage(maximumVoltage)}, ${formatCurrent(current)}`;
      }

      const subtype = (value >>> 28) & 0x03;
      if (subtype === 0) {
        const maximumVoltage = ((value >>> 17) & 0xff) * 0.1;
        const minimumVoltage = ((value >>> 8) & 0xff) * 0.1;
        const current = (value & 0x7f) * 0.05;
        return `${prefix}: PPS APDO ${formatVoltage(minimumVoltage)}–${formatVoltage(maximumVoltage)}, ${formatCurrent(current)}`;
      }
      return `${prefix}: Augmented PDO subtype ${subtype}`;
    }

    function decodeUsbPdRequest(value) {
      const objectPosition = (value >>> 28) & 0x07;
      const operatingCurrent = ((value >>> 10) & 0x3ff) * 0.01;
      const maximumCurrent = (value & 0x3ff) * 0.01;
      const flags = [
        value & (1 << 27) ? "GiveBack" : "",
        value & (1 << 26) ? "CapabilityMismatch" : "",
        value & (1 << 25) ? "USBCommunications" : "",
        value & (1 << 24) ? "NoUSBSuspend" : ""
      ].filter(Boolean);
      return `RDO 0x${value.toString(16).padStart(8, "0").toUpperCase()}: Object position ${objectPosition}, Operating ${formatCurrent(operatingCurrent)}, Maximum ${formatCurrent(maximumCurrent)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
    }

    function decodeUsbPdMessage(payload) {
      const status = payload[0];
      const sop = sopTypes[(status >> 1) & 0x07];
      const lines = [
        `Status 0x${status.toString(16).padStart(2, "0").toUpperCase()}: Error=${Boolean(status & 0x80)} | HardReset=${Boolean(status & 0x40)} | FastRoleSwap=${Boolean(status & 0x20)} | SOP=${sop}`
      ];
      const packetBytes = payload.slice(1);

      if (packetBytes.length < 2) {
        if (packetBytes.length > 0) {
          lines.push("Message Header: 2 bytes required; header is incomplete.");
        } else if (status & 0xe0) {
          lines.push("Control event only; no message header.");
        }
        return lines.join("\n");
      }

      const header = packetBytes[0] | (packetBytes[1] << 8);
      const messageType = header & 0x1f;
      const dataRole = (header >> 5) & 1;
      const revision = (header >> 6) & 0x03;
      const powerRole = (header >> 8) & 1;
      const messageId = (header >> 9) & 0x07;
      const objectCount = (header >> 12) & 0x07;
      const extended = Boolean(header & 0x8000);
      const revisionNames = ["PD 1.0", "PD 2.0", "PD 3.0+", "Reserved"];
      const messageName = objectCount === 0
        ? (usbPdControlMessages[messageType] || `Unknown control message (${messageType})`)
        : (usbPdDataMessages[messageType] || `Unknown data message (${messageType})`);

      lines.push(
        `Message Header 0x${header.toString(16).padStart(4, "0").toUpperCase()}: ${messageName} | ${revisionNames[revision]} | ${powerRole ? "Source" : "Sink"} | ${dataRole ? "DFP" : "UFP"} | Message ID ${messageId} | ${objectCount} data object(s)${extended ? " | Extended" : ""}`
      );

      const body = packetBytes.slice(2);
      if (extended) {
        if (body.length < 2) {
          lines.push("Extended Header: 2 bytes required; header is incomplete.");
          return lines.join("\n");
        }
        const extendedHeader = body[0] | (body[1] << 8);
        const dataSize = extendedHeader & 0x01ff;
        const chunkNumber = (extendedHeader >> 11) & 0x0f;
        lines.push(`Extended Header 0x${extendedHeader.toString(16).padStart(4, "0").toUpperCase()}: ${dataSize} data byte(s), chunk ${chunkNumber}${extendedHeader & 0x8000 ? ", chunked" : ""}${extendedHeader & 0x0400 ? ", chunk request" : ""}`);
        const extendedData = body.slice(2, 2 + dataSize);
        if (extendedData.length > 0) {
          lines.push(`Extended data: ${extendedData.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
        }
        return lines.join("\n");
      }

      if (objectCount === 0) {
        if (body.length > 0) lines.push(`Trailing data: ${body.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
        return lines.join("\n");
      }

      const availableObjects = Math.floor(body.length / 4);
      if (availableObjects < objectCount) {
        lines.push(`Data objects: header declares ${objectCount}, but only ${availableObjects} complete object(s) are present.`);
      }
      const parsedObjectCount = Math.min(objectCount, availableObjects);
      for (let index = 0; index < parsedObjectCount; index += 1) {
        const offset = index * 4;
        const value = (
          body[offset]
          | (body[offset + 1] << 8)
          | (body[offset + 2] << 16)
          | (body[offset + 3] << 24)
        ) >>> 0;
        if ((messageType === 1 || messageType === 4) && !extended) {
          lines.push(decodeUsbPdPdo(value, index + 1));
        } else if (messageType === 2 && !extended && index === 0) {
          lines.push(decodeUsbPdRequest(value));
        } else {
          lines.push(`Data object ${index + 1}: 0x${value.toString(16).padStart(8, "0").toUpperCase()}`);
        }
      }
      const consumedBytes = parsedObjectCount * 4;
      if (body.length > consumedBytes) {
        lines.push(`Trailing data: ${body.slice(consumedBytes).map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
      }
      return lines.join("\n");
    }

    function setStatus(state, text) {
      statusElement.dataset.state = state;
      statusText.textContent = text;
    }

    function showMessage(text, kind = "") {
      messageElement.textContent = text;
      messageElement.dataset.kind = kind;
    }

    function setConnected(connected) {
      controls.forEach((control) => { control.disabled = connected; });
      connectButton.hidden = connected;
      disconnectButton.hidden = !connected;
      disconnectButton.disabled = !connected;
    }

    function formatTime(date) {
      return date.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hour12: false
      });
    }

    function parsePacket(line, terminated, errorOverride) {
      if (errorOverride) return { error: errorOverride };
      if (!terminated) return { error: "改行で終端されていないパケット" };
      if (!line.trim()) return null;
      const match = /^(UART|I2C|SPI|USB-PD|PD):\s*(.*)$/i.exec(line.trim());
      if (!match) return { error: "不明なヘッダーまたは形式です" };

      const rawInterfaceName = match[1].toUpperCase();
      const interfaceName = rawInterfaceName === "PD" ? "USB-PD" : rawInterfaceName;
      const payloadText = match[2].trim();
      if (!payloadText || !/^[\da-f]{2}(?:\s+[\da-f]{2})*$/i.test(payloadText)) {
        return { error: "ペイロードはスペース区切りの2桁16進数で指定してください", interfaceName };
      }

      const payload = payloadText.split(/\s+/).map((byte) => Number.parseInt(byte, 16));
      const displayedPayload = interfaceName === "USB-PD" ? payload.slice(1) : payload;
      const hex = displayedPayload.length === 0
        ? "（なし）"
        : interfaceName === "USB-PD"
          ? formatUsbPdPayload(displayedPayload)
          : displayedPayload.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      let decoded;

      if (interfaceName === "UART") {
        decoded = `ASCII: ${payload.map((byte) =>
          byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."
        ).join("")}`;
      } else if (interfaceName === "USB-PD") {
        decoded = decodeUsbPdMessage(payload);
      } else {
        decoded = `Decimal: ${payload.join(", ")}`;
      }

      const role = interfaceName === "USB-PD" && payload.length >= 3
        ? ((payload[1] | (payload[2] << 8)) & (1 << 8)) ? "source" : "sink"
        : "";
      return { interfaceName, hex, decoded, role };
    }

    function appendPacket(line, terminated = true, errorOverride) {
      const packet = parsePacket(line, terminated, errorOverride);
      if (!packet) return;
      const entry = {
        time: formatTime(new Date()),
        interfaceName: packet.interfaceName || "ERROR",
        hex: packet.hex || line,
        decoded: packet.error || packet.decoded,
        role: packet.error ? "" : packet.role,
        kind: packet.error ? "error" : "packet"
      };
      capturedPackets.push(entry);
      emptyState.hidden = true;

      const row = document.createElement("div");
      row.className = "log-row";
      row.dataset.kind = entry.kind;
      if (entry.role) row.dataset.role = entry.role;
      const values = [
        ["timestamp", entry.time],
        ["interface", entry.interfaceName],
        ["hex", entry.hex],
        ["decoded", entry.decoded]
      ];
      for (const [className, value] of values) {
        const cell = document.createElement("span");
        cell.className = className;
        cell.textContent = value;
        row.append(cell);
      }
      logElement.append(row);
      saveButton.disabled = false;
      if (document.getElementById("autoScroll").checked) {
        logElement.scrollTop = logElement.scrollHeight;
      }
    }

    function appendBytes(bytes) {
      if (bytes.length === 0) return;
      totalBytes += bytes.length;
      byteCounter.textContent = `${totalBytes.toLocaleString()} bytes`;
    }

    async function readSerial(activePort) {
      const decoder = new TextDecoder();
      let pendingLine = "";
      let discardingOversizedLine = false;
      const maxLineLength = 65536;

      function consumeText(text) {
        pendingLine += text;
        while (true) {
          const newlineIndex = pendingLine.indexOf("\n");
          if (discardingOversizedLine) {
            if (newlineIndex === -1) {
              pendingLine = "";
              return;
            }
            pendingLine = pendingLine.slice(newlineIndex + 1);
            discardingOversizedLine = false;
            continue;
          }

          if (newlineIndex !== -1) {
            const line = pendingLine.slice(0, newlineIndex).replace(/\r$/, "");
            pendingLine = pendingLine.slice(newlineIndex + 1);
            if (line.length > maxLineLength) {
              appendPacket(`${line.slice(0, 256)}…`, true, "パケットが最大サイズを超えています");
            } else {
              appendPacket(line);
            }
            continue;
          }

          if (pendingLine.length > maxLineLength) {
            appendPacket(`${pendingLine.slice(0, 256)}…`, false, "パケットが最大サイズを超えています");
            pendingLine = "";
            discardingOversizedLine = true;
          }
          return;
        }
      }

      try {
        let streamEnded = false;
        while (activePort.readable && activePort === port && !streamEnded) {
          reader = activePort.readable.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                consumeText(decoder.decode());
                if (pendingLine.length > 0 && !discardingOversizedLine) appendPacket(pendingLine, false);
                pendingLine = "";
                streamEnded = true;
                break;
              }
              appendBytes(value);
              consumeText(decoder.decode(value, { stream: true }));
            }
          } finally {
            if (reader) {
              reader.releaseLock();
              reader = null;
            }
          }
        }
      } catch (error) {
        if (activePort === port) {
          setStatus("error", "受信エラー");
          showMessage(`受信中にエラーが発生しました: ${error.message}`, "error");
        }
      } finally {
        if (activePort === port) {
          try {
            if (activePort.readable || activePort.writable) await activePort.close();
          } catch (error) {
            showMessage(`ポートを閉じられませんでした: ${error.message}`, "error");
          }
          port = null;
          readTask = null;
          setConnected(false);
          if (statusElement.dataset.state !== "error") setStatus("disconnected", "未接続");
        }
      }
    }

    connectButton.addEventListener("click", async () => {
      if (!("serial" in navigator)) {
        setStatus("error", "非対応ブラウザー");
        showMessage("Web Serial API に対応した Chrome または Edge で開いてください。", "error");
        return;
      }

      const baudRate = Number(document.getElementById("baudRate").value);
      if (!Number.isSafeInteger(baudRate) || baudRate < 1) {
        showMessage("ボーレートには1以上の整数を入力してください。", "error");
        document.getElementById("baudRate").focus();
        return;
      }

      connectButton.disabled = true;
      try {
        const selectedPort = await navigator.serial.requestPort();
        const options = {
          baudRate,
          dataBits: Number(document.getElementById("dataBits").value),
          parity: document.getElementById("parity").value,
          stopBits: Number(document.getElementById("stopBits").value),
          flowControl: document.getElementById("flowControl").value
        };
        await selectedPort.open(options);
        port = selectedPort;
        setConnected(true);
        setStatus("connected", "接続中");
        showMessage(`${baudRate.toLocaleString()} bps で受信しています。`, "success");
        readTask = readSerial(selectedPort);
      } catch (error) {
        if (error.name !== "NotFoundError") {
          setStatus("error", "接続エラー");
          showMessage(`接続できませんでした: ${error.message}`, "error");
        }
      } finally {
        connectButton.disabled = false;
      }
    });

    disconnectButton.addEventListener("click", async () => {
      disconnectButton.disabled = true;
      const activeReader = reader;
      if (activeReader) {
        try {
          await activeReader.cancel();
        } catch (error) {
          showMessage(`受信を停止できませんでした: ${error.message}`, "error");
        }
      }
      if (readTask) await readTask;
      if (port) {
        try {
          await port.close();
        } catch (error) {
          showMessage(`切断時にエラーが発生しました: ${error.message}`, "error");
        }
        port = null;
        setConnected(false);
      }
      setStatus("disconnected", "未接続");
      if (messageElement.dataset.kind !== "error") showMessage("シリアルポートを切断しました。");
    });

    document.getElementById("clearButton").addEventListener("click", () => {
      logElement.replaceChildren();
      logElement.append(emptyState);
      emptyState.hidden = false;
      capturedPackets.length = 0;
      totalBytes = 0;
      byteCounter.textContent = "0 bytes";
      saveButton.disabled = true;
    });

    saveButton.addEventListener("click", () => {
      const header = "TIME\tINTERFACE\tPAYLOAD_HEX\tDECODED\n";
      const body = capturedPackets.map((packet) =>
        [packet.time, packet.interfaceName, packet.hex, packet.decoded.replace(/\n/g, " | ")].join("\t")
      ).join("\n");
      const blob = new Blob([header, body, "\n"], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `serial-dump-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      link.click();
      URL.revokeObjectURL(url);
    });

    if (!("serial" in navigator)) {
      showMessage("Web Serial API に対応した Chrome または Edge で開いてください。", "error");
    }

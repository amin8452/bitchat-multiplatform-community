using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

namespace Bitchat.Windows.Radio;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<int> Main()
    {
        using var radio = new GattPeripheralRadio(WriteEvent);
        WriteEvent(new { @event = "ready", version = 1 });

        while (await Console.In.ReadLineAsync() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var command = JsonDocument.Parse(line);
                var root = command.RootElement;
                var id = root.GetProperty("id").GetInt64();
                var operation = root.GetProperty("operation").GetString();
                object? result = operation switch
                {
                    "start" => await radio.StartAsync(
                        Guid.Parse(root.GetProperty("serviceUuid").GetString()!),
                        Guid.Parse(root.GetProperty("characteristicUuid").GetString()!)),
                    "write" => await radio.NotifyAsync(
                        Convert.FromBase64String(root.GetProperty("data").GetString()!)),
                    "identity.loadOrCreate" => WindowsIdentityVault.LoadOrCreate(
                        root.GetProperty("path").GetString()!),
                    "stop" => radio.Stop(),
                    "shutdown" => radio.Stop(),
                    _ => throw new InvalidOperationException($"Unknown operation: {operation}")
                };
                WriteEvent(new { id, ok = true, result });
                if (operation == "shutdown") break;
            }
            catch (Exception error)
            {
                long? id = null;
                try
                {
                    using var command = JsonDocument.Parse(line);
                    id = command.RootElement.GetProperty("id").GetInt64();
                }
                catch
                {
                    // A malformed command has no usable correlation identifier.
                }
                WriteEvent(new { id, ok = false, error = error.Message });
            }
        }

        return 0;
    }

    private static void WriteEvent(object value)
    {
        lock (JsonOptions)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
            Console.Out.Flush();
        }
    }
}

internal static class WindowsIdentityVault
{
    private const int SecretKeyBytes = 32;
    private static readonly byte[] Header = Encoding.ASCII.GetBytes("BCHATID1");
    private static readonly byte[] Entropy = SHA256.HashData(
        Encoding.UTF8.GetBytes("bitchat-desktop-identity-v1"));

    public static object LoadOrCreate(string requestedPath)
    {
        if (string.IsNullOrWhiteSpace(requestedPath)) {
            throw new InvalidOperationException("The identity path is required");
        }
        var path = Path.GetFullPath(requestedPath);
        var directory = Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException("The identity directory is invalid");
        Directory.CreateDirectory(directory);

        byte[] plaintext;
        if (File.Exists(path))
        {
            plaintext = Unprotect(File.ReadAllBytes(path));
        }
        else
        {
            plaintext = new byte[Header.Length + SecretKeyBytes * 2];
            Header.CopyTo(plaintext, 0);
            RandomNumberGenerator.Fill(plaintext.AsSpan(Header.Length));
            var protectedIdentity = ProtectedData.Protect(
                plaintext,
                Entropy,
                DataProtectionScope.CurrentUser);
            var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
            File.WriteAllBytes(temporaryPath, protectedIdentity);
            try
            {
                File.Move(temporaryPath, path, false);
            }
            catch (IOException) when (File.Exists(path))
            {
                File.Delete(temporaryPath);
                CryptographicOperations.ZeroMemory(plaintext);
                plaintext = Unprotect(File.ReadAllBytes(path));
            }
        }

        try
        {
            if (plaintext.Length != Header.Length + SecretKeyBytes * 2
                || !CryptographicOperations.FixedTimeEquals(
                    plaintext.AsSpan(0, Header.Length),
                    Header))
            {
                throw new InvalidOperationException("The protected identity has an invalid format");
            }
            return new
            {
                scheme = "dpapi-current-user-v1",
                noiseSecretKey = Convert.ToBase64String(
                    plaintext.AsSpan(Header.Length, SecretKeyBytes)),
                signingSecretKey = Convert.ToBase64String(
                    plaintext.AsSpan(Header.Length + SecretKeyBytes, SecretKeyBytes))
            };
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private static byte[] Unprotect(byte[] protectedIdentity)
    {
        try
        {
            return ProtectedData.Unprotect(
                protectedIdentity,
                Entropy,
                DataProtectionScope.CurrentUser);
        }
        catch (CryptographicException error)
        {
            throw new InvalidOperationException(
                "The Windows identity cannot be decrypted for the current user",
                error);
        }
    }
}

internal sealed class GattPeripheralRadio : IDisposable
{
    private const int SafeDefaultNotificationBytes = 20;
    private const int AdvertisementStartAttempts = 3;
    private const int AdvertisementStatusPolls = 25;
    private readonly Action<object> emit;
    private GattServiceProvider? provider;
    private GattLocalCharacteristic? characteristic;

    public GattPeripheralRadio(Action<object> emit)
    {
        this.emit = emit;
    }

    public async Task<object> StartAsync(Guid serviceUuid, Guid characteristicUuid)
    {
        Stop();
        var adapter = await BluetoothAdapter.GetDefaultAsync();
        if (adapter is null) throw new InvalidOperationException("No Bluetooth adapter is available");
        if (!adapter.IsLowEnergySupported) {
            throw new InvalidOperationException("The Bluetooth adapter does not support Bluetooth Low Energy");
        }
        if (!adapter.IsPeripheralRoleSupported) {
            throw new InvalidOperationException(
                "The Bluetooth adapter does not support the BLE peripheral role required for mesh advertising");
        }

        Exception? lastError = null;
        for (var attempt = 1; attempt <= AdvertisementStartAttempts; attempt += 1)
        {
            try
            {
                await StartOnceAsync(serviceUuid, characteristicUuid);
                return new
                {
                    serviceUuid,
                    characteristicUuid,
                    advertising = provider!.AdvertisementStatus.ToString(),
                    attempt
                };
            }
            catch (Exception error)
            {
                lastError = error;
                Stop();
                if (attempt < AdvertisementStartAttempts)
                {
                    await Task.Delay(250 * attempt);
                }
            }
        }

        throw new InvalidOperationException(
            $"GATT advertising failed after {AdvertisementStartAttempts} attempts: {lastError?.Message}",
            lastError);
    }

    private async Task StartOnceAsync(Guid serviceUuid, Guid characteristicUuid)
    {
        var providerResult = await GattServiceProvider.CreateAsync(serviceUuid);
        if (providerResult.Error != BluetoothError.Success)
        {
            throw new InvalidOperationException($"Unable to create GATT service: {providerResult.Error}");
        }

        var parameters = new GattLocalCharacteristicParameters
        {
            CharacteristicProperties = GattCharacteristicProperties.Write
                | GattCharacteristicProperties.WriteWithoutResponse
                | GattCharacteristicProperties.Notify,
            WriteProtectionLevel = GattProtectionLevel.Plain
        };
        var characteristicResult = await providerResult.ServiceProvider.Service.CreateCharacteristicAsync(
            characteristicUuid,
            parameters);
        if (characteristicResult.Error != BluetoothError.Success)
        {
            throw new InvalidOperationException(
                $"Unable to create GATT characteristic: {characteristicResult.Error}");
        }

        provider = providerResult.ServiceProvider;
        characteristic = characteristicResult.Characteristic;
        characteristic.WriteRequested += OnWriteRequested;
        characteristic.SubscribedClientsChanged += OnSubscribedClientsChanged;
        provider.AdvertisementStatusChanged += OnAdvertisementStatusChanged;
        provider.StartAdvertising(new GattServiceProviderAdvertisingParameters
        {
            IsConnectable = true,
            IsDiscoverable = true
        });
        for (var poll = 0; poll < AdvertisementStatusPolls
            && provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started;
            poll += 1)
        {
            await Task.Delay(100);
        }
        if (provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started)
        {
            throw new InvalidOperationException(
                $"GATT advertising did not start: {provider.AdvertisementStatus}");
        }
    }

    public async Task<object> NotifyAsync(byte[] value)
    {
        if (characteristic is null) throw new InvalidOperationException("GATT server is not running");
        var clients = characteristic.SubscribedClients.ToArray();
        var successfulChunks = 0;
        foreach (var client in clients)
        {
            var maximumBytes = SafeDefaultNotificationBytes;
            try
            {
                maximumBytes = Math.Max(SafeDefaultNotificationBytes, client.Session.MaxPduSize - 3);
            }
            catch
            {
                // Some Bluetooth stacks do not expose the negotiated PDU size.
            }

            for (var offset = 0; offset < value.Length; offset += maximumBytes)
            {
                var length = Math.Min(maximumBytes, value.Length - offset);
                using var writer = new DataWriter();
                writer.WriteBytes(value.AsSpan(offset, length).ToArray());
                var result = await characteristic.NotifyValueAsync(writer.DetachBuffer(), client);
                if (result.Status == GattCommunicationStatus.Success) successfulChunks += 1;
            }
        }
        return new { clients = clients.Length, chunks = successfulChunks };
    }

    public object Stop()
    {
        if (characteristic is not null)
        {
            characteristic.WriteRequested -= OnWriteRequested;
            characteristic.SubscribedClientsChanged -= OnSubscribedClientsChanged;
        }
        if (provider is not null)
        {
            provider.AdvertisementStatusChanged -= OnAdvertisementStatusChanged;
            provider.StopAdvertising();
        }
        characteristic = null;
        provider = null;
        return new { stopped = true };
    }

    public void Dispose()
    {
        Stop();
    }

    private async void OnWriteRequested(
        GattLocalCharacteristic sender,
        GattWriteRequestedEventArgs arguments)
    {
        var deferral = arguments.GetDeferral();
        try
        {
            var request = await arguments.GetRequestAsync();
            if (request is null) return;
            using var reader = DataReader.FromBuffer(request.Value);
            var bytes = new byte[request.Value.Length];
            reader.ReadBytes(bytes);
            emit(new { @event = "data", data = Convert.ToBase64String(bytes) });
            if (request.Option == GattWriteOption.WriteWithResponse) request.Respond();
        }
        catch (Exception error)
        {
            emit(new { @event = "error", error = error.Message });
        }
        finally
        {
            deferral.Complete();
        }
    }

    private void OnSubscribedClientsChanged(
        GattLocalCharacteristic sender,
        object arguments)
    {
        emit(new { @event = "subscribers", count = sender.SubscribedClients.Count });
    }

    private void OnAdvertisementStatusChanged(
        GattServiceProvider sender,
        GattServiceProviderAdvertisementStatusChangedEventArgs arguments)
    {
        emit(new { @event = "status", status = arguments.Status.ToString() });
    }
}

using Microsoft.Extensions.DependencyInjection;
using ReiTunes.Activation;
using ReiTunes.Configuration;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Windows.ApplicationModel.Activation;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace ReiTunes.Services {

    // For more information on understanding and extending activation flow see
    // https://github.com/Microsoft/WindowsTemplateStudio/blob/master/docs/UWP/activation.md
    static internal class Startup {
        static private readonly ServiceCollection _serviceCollection = new ServiceCollection();
        static private readonly Type _startupViewType = typeof(Player);

        static public async Task ActivateAsync(object activationArgs) {
            if (IsInteractive(activationArgs)) {
                ServiceLocator.Configure(_serviceCollection);

                // Do not repeat app initialization when the Window already has content,
                // just ensure that the window is active
                if (Window.Current.Content == null) {
                    // Create a Frame to act as the navigation context
                    Window.Current.Content = new Frame();
                }
            }

            // Depending on activationArgs one of ActivationHandlers or DefaultActivationHandler
            // will navigate to the first page
            await HandleActivationAsync(activationArgs);

            if (IsInteractive(activationArgs)) {
                IActivatedEventArgs activation = activationArgs as IActivatedEventArgs;
                if (activation.PreviousExecutionState == ApplicationExecutionState.Terminated) {
                    await ServiceLocator.Current.GetService<SuspendAndResumeService>().RestoreSuspendAndResumeData();
                }

                // Ensure the current window is active
                Window.Current.Activate();

                // Tasks after activation
                await StartupAsync();
            }
        }

        static private async Task HandleActivationAsync(object activationArgs) {
            ActivationHandler activationHandler = GetActivationHandlers()
                                                .FirstOrDefault(h => h.CanHandle(activationArgs));

            if (activationHandler != null) {
                await activationHandler.HandleAsync(activationArgs);
            }

            if (IsInteractive(activationArgs)) {
                DefaultActivationHandler defaultHandler = new DefaultActivationHandler(_startupViewType);
                if (defaultHandler.CanHandle(activationArgs)) {
                    await defaultHandler.HandleAsync(activationArgs);
                }
            }
        }

        static private async Task StartupAsync() {
            await WhatsNewDisplayService.ShowIfAppropriateAsync();
            await FirstRunService.ShowIfAppropriateAsync();
        }

        static private IEnumerable<ActivationHandler> GetActivationHandlers() {
            yield return ServiceLocator.Current.GetService<SuspendAndResumeService>();
            yield return ServiceLocator.Current.GetService<CommandLineActivationHandler>();
        }

        static private bool IsInteractive(object args) {
            return args is IActivatedEventArgs;
        }
    }
}
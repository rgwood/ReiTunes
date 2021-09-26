using System.Linq;
using System.Threading.Tasks;

using Windows.ApplicationModel.Activation;

namespace ReiTunes.Activation
{
    internal class CommandLineActivationHandler : ActivationHandler<CommandLineActivatedEventArgs>
    {
        internal static string IdOfItemToPlayOnStartup = null;

        // fzf gives us args like "559146d5-4901-4e09-abd9-e732a23f8429\tSongTitle...
        // strip away quotes and everything from the \t onward
        internal static string TrimArgsToGuidOnly(string input) {
            return input.Substring(0, input.IndexOf('\t'))
                .Trim('\"');
        }

        // Learn more about these EventArgs at https://docs.microsoft.com/en-us/uwp/api/windows.applicationmodel.activation.commandlineactivatedeventargs
        protected override async Task HandleInternalAsync(CommandLineActivatedEventArgs args)
        {
            CommandLineActivationOperation operation = args.Operation;

            // Because these are supplied by the caller, they should be treated as untrustworthy.
            string cmdLineString = operation.Arguments;

            IdOfItemToPlayOnStartup = TrimArgsToGuidOnly(cmdLineString);

            // The directory where the command-line activation request was made.
            // This is typically not the install location of the app itself, but could be any arbitrary path.
            string activationPath = operation.CurrentDirectoryPath;

            //// TODO WTS: parse the cmdLineString to determine what to do.
            //// If doing anything async, get a deferral first.
            //// using (var deferral = operation.GetDeferral())
            //// {
            ////     await ParseCmdString(cmdLineString, activationPath);
            //// }
            ////
            //// If the arguments warrant showing a different view on launch, that can be done here.
            //// NavigationService.Navigate(typeof(CmdLineActivationSamplePage), cmdLineString);
            //// If you do nothing, the app will launch like normal.

            await Task.CompletedTask;
        }

        protected override bool CanHandleInternal(CommandLineActivatedEventArgs args)
        {
            // Only handle a commandline launch if arguments are passed.
            return args?.Operation.Arguments.Any() ?? false;
        }
    }
}
import { BookOpen, Heart, Star, Users } from "lucide-react"
import { useTranslation } from "react-i18next"

import { REPO_URL } from "~/constants/about"
import { useIsStarred } from "~/features/StarPromotion/useStarPromotionActive"
import { cn } from "~/lib/utils"
import { createTab } from "~/utils/browser/tabs"
import { isWebService } from "~/utils/browser/webService"
import { getDocsHomepageUrl } from "~/utils/navigation/docsLinks"

import { SupportCommunityPopover } from "./SupportCommunityPopover"

export interface OptionsSidebarFooterProps {
  isCollapsed?: boolean
  onMenuItemClick?: (itemId: string) => void
}

/**
 * Options sidebar footer providing ecosystem shortcuts:
 * - GitHub (reflects Star reminder status without redundant interactive sub-buttons)
 * - Official Documentation (BookOpen)
 * - Sponsor & Support (Heart)
 * - Community Hub (Send / Paper airplane)
 */
export function OptionsSidebarFooter({
  isCollapsed = false,
}: OptionsSidebarFooterProps) {
  const { t, i18n } = useTranslation(["ui", "about"])
  const isStarred = useIsStarred()

  const handleStarClick = () => {
    void createTab(REPO_URL, true)
  }

  const starTooltip = isStarred
    ? t("ui:starPromotion.actions.alreadyStarred")
    : t("ui:feedback.starOnGithub")
  const githubLabel = t("ui:sidebarFooter.github")
  const docsLabel = t("ui:sidebarFooter.docs")
  const docsTitle = t("about:homepageDesc")
  const sponsorLabel = t("ui:sidebarFooter.sponsor")
  const sponsorTitle = t("ui:feedback.sponsorTitle")
  const communityLabel = t("ui:sidebarFooter.community")
  const communityTitle = t("about:feedbackSection.community.description")

  if (isCollapsed) {
    return (
      <div
        data-testid="options-sidebar-footer"
        className="mt-auto flex flex-col items-center gap-1.5 border-t border-sidebar-border py-2.5"
      >
        {/* GitHub / Star */}
        <button
          type="button"
          data-testid="sidebar-footer-github"
          onClick={handleStarClick}
          title={starTooltip}
          aria-label={starTooltip}
          className="group flex size-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isStarred ? (
            <Star className="size-4 shrink-0 fill-star text-star transition-colors" />
          ) : (
            <Star className="size-4 shrink-0 text-sidebar-foreground/70 transition-colors group-hover:text-star" />
          )}
        </button>

        {/* Documentation */}
        <button
          type="button"
          data-testid="sidebar-footer-docs"
          onClick={() =>
            void createTab(getDocsHomepageUrl(i18n.language), true)
          }
          title={docsTitle}
          aria-label={docsLabel}
          className="flex size-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BookOpen className="size-4 shrink-0" />
        </button>

        {/* Sponsor */}
        {!isWebService() && (
          <SupportCommunityPopover
            section="sponsors"
            side="right"
            align="center"
          >
            <button
              type="button"
              data-testid="sidebar-footer-sponsor"
              title={sponsorTitle}
              aria-label={sponsorLabel}
              className="flex size-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Heart className="size-4 shrink-0 text-destructive-indicator/80" />
            </button>
          </SupportCommunityPopover>
        )}

        {/* Community */}
        <SupportCommunityPopover
          section="community"
          side="right"
          align="center"
        >
          <button
            type="button"
            data-testid="sidebar-footer-community"
            title={communityTitle}
            aria-label={communityLabel}
            className="flex size-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Users className="size-4 shrink-0" />
          </button>
        </SupportCommunityPopover>
      </div>
    )
  }

  return (
    <div
      data-testid="options-sidebar-footer"
      className="mt-auto border-t border-sidebar-border p-2"
    >
      <div className="grid grid-cols-2 gap-1">
        {/* GitHub / Star Button */}
        <button
          type="button"
          data-testid="sidebar-footer-github"
          onClick={handleStarClick}
          title={starTooltip}
          aria-label={starTooltip}
          className={cn(
            "group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isStarred
              ? "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          <Star
            data-testid="sidebar-footer-star-icon"
            className={cn(
              "size-3.5 shrink-0 transition-colors",
              isStarred
                ? "fill-star text-star"
                : "text-sidebar-foreground/70 group-hover:text-star",
            )}
          />
          <span className="truncate">{githubLabel}</span>
        </button>

        {/* Docs Button */}
        <button
          type="button"
          data-testid="sidebar-footer-docs"
          onClick={() =>
            void createTab(getDocsHomepageUrl(i18n.language), true)
          }
          title={docsTitle}
          aria-label={docsLabel}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-sidebar-foreground/75 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BookOpen className="size-3.5 shrink-0 text-sidebar-foreground/70" />
          <span className="truncate">{docsLabel}</span>
        </button>

        {/* Sponsor Button */}
        {!isWebService() && (
          <SupportCommunityPopover section="sponsors" side="top" align="start">
            <button
              type="button"
              data-testid="sidebar-footer-sponsor"
              title={sponsorTitle}
              aria-label={sponsorLabel}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-sidebar-foreground/75 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Heart className="size-3.5 shrink-0 text-destructive-indicator/80" />
              <span className="truncate">{sponsorLabel}</span>
            </button>
          </SupportCommunityPopover>
        )}

        {/* Community Button */}
        <SupportCommunityPopover section="community" side="top" align="end">
          <button
            type="button"
            data-testid="sidebar-footer-community"
            title={communityTitle}
            aria-label={communityLabel}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-sidebar-foreground/75 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Users className="size-3.5 shrink-0 text-sidebar-foreground/70" />
            <span className="truncate">{communityLabel}</span>
          </button>
        </SupportCommunityPopover>
      </div>
    </div>
  )
}
